import { randomUUID } from 'node:crypto';
import {
	claimOffeneSelbstEpisoden,
	markiereVeroeffentlicht,
	type OffeneEpisode
} from '../alarm/db';
import { entwarnungFaellig } from '../alarm/lebenszyklus';
import { entschluessele } from '../crypto';
import { getDb } from '../db/client';
import { env } from '../env';
import { createLogger, describeError } from '../logger';
import { wendeAn, type ZustandsSicht } from '../monitor/zustand';
import { erzeugeWebhookPort, type WebhookPort } from '../webhook/client';
import type { AlarmEreignis } from '../db/schema/enums';
import type { Tx } from '../zuordnung/db';
import { kernWirkungen, postfachWirkungen, type SelbstWirkung } from './beobachtung';
import {
	istUnveraendert,
	leererCache,
	liesCache,
	schreibeCache,
	type CacheZiel,
	type WatchdogCache
} from './cache';
import {
	beendeSelbstStill,
	holePingKonfig,
	ladeCacheZiele,
	ladeDienste,
	ladePostfachBeobachtungen,
	schreibeSelbstWirkung,
	sperreSelbstMonitore,
	vermerkePing,
	zustellStoerungSeit,
	type SelbstLaufzeit
} from './db';
import { notfallEreignis, notfallSchritt, sendeNotfall } from './notfall';
import {
	erzeugePingPort,
	innereGesundheit,
	istAngekommen,
	pingFaellig,
	type PingPort
} from './ping';
import {
	baueVersandPorts,
	oeffneSelbstZustellungen,
	sendeOffene,
	type VersandPorts
} from './versand';

/**
 * The watchdog's main loop (SPEC §2, §8): evaluate the self-monitors, publish and send what they
 * owe, keep the emergency cache warm, and ping outwards while everything is fine.
 *
 * Deliberately not a pg-boss job, and not in the worker either. Both live in the database this loop
 * has to be able to alarm *about*; a self-monitor that needs a healthy queue in order to report a
 * broken queue would be no self-monitor at all.
 */

const log = createLogger('selbst');

/** Self-monitors are few and fixed, so one page always holds every episode that owes an event. */
const EPISODEN_PRO_TICK = 100;

export interface SelbstBericht {
	dbErreichbar: boolean;
	/** State changes written this pass. */
	wirkungen: number;
	/** Events published this pass. */
	veroeffentlicht: number;
	/** Deliveries executed this pass. */
	gesendet: number;
	notfall: 'nichts' | 'alarm' | 'entwarnung';
	pingGesendet: boolean;
}

export interface AuswertungsOptionen {
	jetzt?: Date;
	/** When this watchdog started watching — what a service that never reported in is judged from. */
	beobachtetSeit?: Date;
	cacheDatei?: string;
	webhookPort?: WebhookPort;
	pingPort?: PingPort;
	/** Injected in tests; built from the settings once per tick in production. */
	versandPorts?: VersandPorts;
	db?: ReturnType<typeof getDb>;
}

// ---------------------------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------------------------

/** Self-monitors are never pausable, so the overlay is always off — except where it carries the
 * Wurzel-Unterdrückung, which is exactly the same suppression one level up. */
function sicht(laufzeit: SelbstLaufzeit, unterdrueckt: boolean): ZustandsSicht {
	return {
		zustand: laufzeit.zustand,
		alarmgrund: laufzeit.alarmgrund,
		pausiert: unterdrueckt,
		pausiertBis: null
	};
}

async function foldeWirkungen(
	laufzeit: SelbstLaufzeit,
	wirkungen: SelbstWirkung[],
	unterdrueckt: boolean,
	tx: Tx
): Promise<{ laufzeit: SelbstLaufzeit; geschrieben: number }> {
	let aktuell = laufzeit;
	let geschrieben = 0;

	for (const { wirkung, zeitpunkt } of wirkungen) {
		const aenderung = wendeAn(sicht(aktuell, unterdrueckt), wirkung, zeitpunkt);
		if (aenderung.art === 'keine') continue;
		aktuell = await schreibeSelbstWirkung(aktuell, aenderung, zeitpunkt, tx);
		geschrieben++;
	}

	return { laufzeit: aktuell, geschrieben };
}

/**
 * One evaluation pass over every self-monitor, in one transaction.
 *
 * **The core goes first, and that is load-bearing.** „Ist der Kern gestört, feuern die
 * Postfach-Selbst-Monitore nicht zusätzlich" (CONTEXT „Wurzel-Unterdrückung") — and the suppression
 * has to read the core's state *after* this tick's transition, not the row that was read when the
 * tick began. In the first tick of an outage both become true at once: the worker falls silent and
 * every mailbox goes stale in the same pass. Judged against the core as it looked a minute ago, each
 * mailbox would open its own episode alongside the core's — precisely the ticket storm the
 * suppression exists to prevent.
 *
 * The suppression itself is not new code: `wendeAn()` under `Pausiert` blocks the way *into* Gestört
 * and lets recovery through, which is exactly what a root cause should do to its symptoms.
 */
export async function werteSelbstMonitoreAus(
	jetzt: Date,
	beobachtetSeit: Date,
	tx: Tx
): Promise<{ laufzeiten: SelbstLaufzeit[]; wirkungen: number }> {
	const laufzeiten = await sperreSelbstMonitore(tx);
	const beobachtungen = await ladePostfachBeobachtungen(tx);
	const dienste = await ladeDienste(tx);
	const stoerungSeit = await zustellStoerungSeit(tx);

	let wirkungen = 0;
	const ergebnis: SelbstLaufzeit[] = [];

	const kern = laufzeiten.find((laufzeit) => laufzeit.art === 'kern');
	let kernGestoert = false;

	if (kern) {
		const gefaltet = await foldeWirkungen(
			kern,
			kernWirkungen(
				kern,
				{ dienste, zustellStoerungSeit: stoerungSeit, beobachtetSeit },
				kern.stalenessSekunden,
				jetzt
			),
			false,
			tx
		);
		wirkungen += gefaltet.geschrieben;
		kernGestoert = gefaltet.laufzeit.zustand === 'gestoert';
		ergebnis.push(gefaltet.laufzeit);
	}

	for (const laufzeit of laufzeiten) {
		if (laufzeit.art === 'kern') continue;

		const beobachtung = laufzeit.postfachId ? beobachtungen.get(laufzeit.postfachId) : undefined;

		// A retired mailbox monitor (its mailbox was deleted) and a deactivated mailbox are the same
		// case: nothing is being polled on purpose, so a running disruption ends without an all-clear.
		if (!beobachtung || !beobachtung.aktiv) {
			if (laufzeit.zustand === 'gestoert') {
				ergebnis.push(await beendeSelbstStill(laufzeit, jetzt, tx));
				wirkungen++;
			} else {
				ergebnis.push(laufzeit);
			}
			continue;
		}

		const gefaltet = await foldeWirkungen(
			laufzeit,
			postfachWirkungen(laufzeit, beobachtung, laufzeit.stalenessSekunden, jetzt),
			kernGestoert,
			tx
		);
		wirkungen += gefaltet.geschrieben;
		ergebnis.push(gefaltet.laufzeit);
	}

	return { laufzeiten: ergebnis, wirkungen };
}

// ---------------------------------------------------------------------------------------------
// Veröffentlichen
// ---------------------------------------------------------------------------------------------

/**
 * Turns the self-monitors' transitions into events — the watchdog's own copy of what
 * `alarm/scheduler.ts` does for customer monitors, minus the paging and minus the queue.
 *
 * The all-clear is judged against `jetzt` rather than against the Bewertungs-Schranke: a
 * self-monitor recovers on a successful poll or a fresh heartbeat, neither of which travels through
 * the mail pipeline, so there is no backlog whose draining it would have to wait for.
 */
async function veroeffentliche(
	episode: OffeneEpisode,
	ereignis: AlarmEreignis,
	jetzt: Date,
	tx: Tx
): Promise<void> {
	await markiereVeroeffentlicht(episode.id, ereignis, jetzt, tx);
	const zustellungen = await oeffneSelbstZustellungen(episode.id, ereignis, tx);

	log.info('Selbst-Ereignis veröffentlicht', {
		ereignis,
		alertId: episode.alertId,
		monitor: episode.selbst?.schluessel ?? null,
		zustellungen
	});
}

export async function veroeffentlicheSelbstEreignisse(jetzt: Date, tx: Tx): Promise<number> {
	const episoden = await claimOffeneSelbstEpisoden(EPISODEN_PRO_TICK, tx);
	let ereignisse = 0;

	for (const episode of episoden) {
		let alarmRaus = episode.alarmiertAm !== null;
		if (!alarmRaus) {
			await veroeffentliche(episode, 'alarm', jetzt, tx);
			alarmRaus = true;
			ereignisse++;
		}

		if (alarmRaus && episode.verschaerftAm !== null && episode.verschaerfungGemeldetAm === null) {
			await veroeffentliche(episode, 'verschaerfung', jetzt, tx);
			ereignisse++;
		}

		const beendetAm = episode.beendetAm;
		if (
			alarmRaus &&
			beendetAm !== null &&
			episode.entwarntAm === null &&
			episode.entwarnungEntfaelltAm === null &&
			episode.erholungsArt !== 'archiviert' &&
			entwarnungFaellig(beendetAm, episode.stabilitaetSekunden, jetzt)
		) {
			await veroeffentliche(episode, 'entwarnung', jetzt, tx);
			ereignisse++;
		}
	}

	return ereignisse;
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

/**
 * Refreshes the emergency cache from the database — the only moment the watchdog can learn anything.
 *
 * Written only when something actually changed, so a volume does not take a write every few seconds
 * for the lifetime of the instance. Failing to write is logged and swallowed: a stale cache is worth
 * far more than a watchdog that dies of a full disk.
 */
async function frischeCacheAuf(
	vorher: WatchdogCache | null,
	kern: SelbstLaufzeit | undefined,
	datei: string,
	db: ReturnType<typeof getDb>
): Promise<WatchdogCache> {
	const ziele: CacheZiel[] = [];
	for (const zeile of await ladeCacheZiele(db)) {
		// An unsigned webhook is not a supported mode (SPEC §7), so a receiver without a secret is one
		// the emergency path could not call anyway.
		if (!zeile.secretChiffre) continue;
		try {
			ziele.push({ id: zeile.id, url: zeile.url, secret: entschluessele(zeile.secretChiffre) });
		} catch (err: unknown) {
			// A secret that will not decrypt could not be signed with either; leaving the receiver out
			// of the cache reaches the same outcome as the normal path, one step earlier.
			log.warn('Webhook-Secret nicht entschlüsselbar', {
				ziel: zeile.id,
				error: describeError(err)
			});
		}
	}

	const neu: WatchdogCache = {
		...leererCache(env.basisUrl),
		basisUrl: env.basisUrl,
		kern: kern
			? {
					id: kern.id,
					schluessel: kern.schluessel,
					bezeichnung: kern.bezeichnung,
					stalenessSekunden: kern.stalenessSekunden,
					stabilitaetSekunden: kern.entwarnungsStabilitaetSekunden
				}
			: (vorher?.kern ?? null),
		webhookZiele: ziele,
		notfall: vorher?.notfall ?? null
	};

	if (!istUnveraendert(vorher, neu)) {
		await schreibeCache(datei, neu).catch((err: unknown) => {
			log.warn('Watchdog-Cache nicht schreibbar', { datei, error: describeError(err) });
		});
	}

	return neu;
}

// ---------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------

/**
 * Runs one full pass.
 *
 * Everything that needs the database sits inside one `try`, and any failure in it means exactly one
 * thing: the database is unreachable. That is the signal the emergency path runs on — it is not an
 * error to be logged and shrugged off, it is the one disruption nothing else can observe.
 */
export async function werteSelbstAus(optionen: AuswertungsOptionen = {}): Promise<SelbstBericht> {
	const db = optionen.db ?? getDb();
	const jetzt = optionen.jetzt ?? new Date();
	const beobachtetSeit = optionen.beobachtetSeit ?? jetzt;
	const datei = optionen.cacheDatei ?? env.watchdogCacheFile;

	let cache = await liesCache(datei);
	let dbErreichbar = true;
	let wirkungen = 0;
	let veroeffentlicht = 0;
	let gesendet = 0;
	let pingGesendet = false;

	try {
		const bewertung = await db.transaction((tx) =>
			werteSelbstMonitoreAus(jetzt, beobachtetSeit, tx)
		);
		const laufzeiten = bewertung.laufzeiten;
		wirkungen = bewertung.wirkungen;

		veroeffentlicht = await db.transaction((tx) => veroeffentlicheSelbstEreignisse(jetzt, tx));

		const ports = optionen.versandPorts ?? (await baueVersandPorts(db));
		gesendet = await sendeOffene(ports, jetzt, db);

		cache = await frischeCacheAuf(
			cache,
			laufzeiten.find((laufzeit) => laufzeit.art === 'kern'),
			datei,
			db
		);

		pingGesendet = await sendePingWennGesund(laufzeiten, jetzt, optionen, db);
	} catch (err: unknown) {
		dbErreichbar = false;
		log.error('Datenbank nicht erreichbar', { error: describeError(err) });
	}

	const notfall = await behandleNotfall(cache, dbErreichbar, datei, jetzt, optionen);

	if (wirkungen > 0 || veroeffentlicht > 0 || gesendet > 0) {
		log.info('Selbst-Auswertung', { wirkungen, veroeffentlicht, gesendet });
	}

	return { dbErreichbar, wirkungen, veroeffentlicht, gesendet, notfall, pingGesendet };
}

async function sendePingWennGesund(
	laufzeiten: SelbstLaufzeit[],
	jetzt: Date,
	optionen: AuswertungsOptionen,
	db: ReturnType<typeof getDb>
): Promise<boolean> {
	if (!innereGesundheit(true, laufzeiten)) return false;

	const konfig = await holePingKonfig(db);
	if (konfig.urlChiffre === null) return false;
	if (!pingFaellig(konfig.zuletztAm, konfig.intervallSekunden, jetzt)) return false;

	const port = optionen.pingPort ?? erzeugePingPort();

	try {
		const status = await port.sende(entschluessele(konfig.urlChiffre));
		if (!istAngekommen(status)) {
			log.warn('Heartbeat-Ping abgelehnt', { status });
			return false;
		}
	} catch (err: unknown) {
		log.warn('Heartbeat-Ping fehlgeschlagen', { error: describeError(err) });
		return false;
	}

	await vermerkePing(jetzt, db);
	return true;
}

/**
 * The emergency path: decide, send, persist — in that order, and only ever one send per decision.
 *
 * Without a readable cache there is nothing to do. That is a real state, not an oversight: the
 * cache needs `NIGHTWATCH_SECRET_KEY` to be written at all, and an instance that never configured
 * one has no secrets to protect and no receiver to alarm either.
 */
async function behandleNotfall(
	cache: WatchdogCache | null,
	dbErreichbar: boolean,
	datei: string,
	jetzt: Date,
	optionen: AuswertungsOptionen
): Promise<SelbstBericht['notfall']> {
	if (cache === null || cache.kern === null) return 'nichts';

	const schritt = notfallSchritt(
		cache.notfall,
		dbErreichbar,
		{
			stalenessSekunden: cache.kern.stalenessSekunden,
			stabilitaetSekunden: cache.kern.stabilitaetSekunden
		},
		randomUUID(),
		jetzt
	);

	if (schritt.aktion !== 'nichts' && schritt.meldung !== null) {
		const daten = notfallEreignis(
			cache.kern,
			schritt.meldung,
			schritt.aktion === 'alarm' ? 'alarm' : 'entwarnung',
			cache.basisUrl
		);
		const port = optionen.webhookPort ?? erzeugeWebhookPort();
		const zugestellt = await sendeNotfall(cache.webhookZiele, daten, port, jetzt);

		log.error('Notfall-Meldung gesendet', {
			aktion: schritt.aktion,
			alertId: schritt.meldung.alertId,
			ziele: cache.webhookZiele.length,
			zugestellt
		});
	}

	// Persisted *after* the send, so a crash in between repeats the send rather than losing it — the
	// same at-least-once trade the webhook channel makes, and the `alert_id` is what makes the repeat
	// harmless at the receiver.
	if (JSON.stringify(schritt.episode) !== JSON.stringify(cache.notfall)) {
		await schreibeCache(datei, { ...cache, notfall: schritt.episode }).catch((err: unknown) => {
			log.warn('Notfall-Zustand nicht speicherbar', { datei, error: describeError(err) });
		});
	}

	return schritt.aktion;
}

// ---------------------------------------------------------------------------------------------
// Schleife
// ---------------------------------------------------------------------------------------------

export interface SelbstScheduler {
	/** Runs one tick. Exposed so a caller can drive it deterministically instead of waiting. */
	tick(): Promise<void>;
	stop(): void;
}

export interface SchedulerOptionen {
	tickMs: number;
	jetzt?: () => Date;
	/** Injected in tests so the loop's own behaviour is checkable without a database. */
	verarbeite?: (jetzt: Date) => Promise<void>;
}

/**
 * Starts the loop. Overlapping ticks are skipped rather than queued, exactly like every other
 * scheduler in this service.
 */
export function startSelbstScheduler(optionen: SchedulerOptionen): SelbstScheduler {
	const jetztAus = optionen.jetzt ?? (() => new Date());
	const beobachtetSeit = jetztAus();
	const verarbeite =
		optionen.verarbeite ??
		(async (jetzt: Date) => void (await werteSelbstAus({ jetzt, beobachtetSeit })));
	let laeuft = false;

	async function tick(): Promise<void> {
		await verarbeite(jetztAus());
	}

	function geschuetzterTick(): void {
		if (laeuft) return;
		laeuft = true;
		tick()
			.catch((err: unknown) => log.warn('Tick fehlgeschlagen', { error: describeError(err) }))
			.finally(() => {
				laeuft = false;
			});
	}

	const timer = setInterval(geschuetzterTick, optionen.tickMs);
	geschuetzterTick();

	return {
		tick,
		stop(): void {
			clearInterval(timer);
		}
	};
}
