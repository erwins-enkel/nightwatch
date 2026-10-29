import { baueEreignis, type AlarmEreignisDaten, type EpisodenSicht } from '../alarm/ereignis';
import { stabilitaetEndeAm } from '../alarm/lebenszyklus';
import type { AlarmEreignis } from '../db/schema/enums';
import { createLogger, describeError } from '../logger';
import { koerper } from '../webhook/nutzlast';
import { signiere, SIGNATUR_KOPF } from '../webhook/signatur';
import type { WebhookPort } from '../webhook/client';
import { env } from '../env';
import type { CacheKern, CacheZiel, NotfallEpisode } from './cache';

/**
 * The one disruption Nightwatch cannot record while it is happening: its own database (SPEC §8).
 *
 * Everything else about a self-monitor lives in `uebergang`; this episode cannot, so it runs its
 * whole life out of the encrypted cache file instead. The decision itself is pure and sits here so
 * that „alarms once, all-clears once, and survives any number of ticks in between" is a table of
 * cases rather than a stateful thing to reason about.
 */

const log = createLogger('selbst');

export type NotfallAktion = 'nichts' | 'alarm' | 'entwarnung';

export interface NotfallSchritt {
	/** The episode to persist in the cache — null means there is nothing in flight. */
	episode: NotfallEpisode | null;
	aktion: NotfallAktion;
	/** The episode the action reports; null when nothing is to be sent. */
	meldung: NotfallEpisode | null;
}

export interface NotfallFristen {
	/** How long the database may be silent before it counts as a disruption. */
	stalenessSekunden: number;
	/** How long the recovery has to hold before the all-clear goes out. */
	stabilitaetSekunden: number;
}

/**
 * One tick of the emergency path.
 *
 * The rules are the ordinary lifecycle, applied to a monitor whose storage is gone:
 *
 * - A blip is not a disruption. The outage has to outlast the core's staleness window before it
 *   alarms — the same window a stale service gets.
 * - The alarm goes out **once**. `alarmiertAm` in the cache is the whole dedup mechanism, and it is
 *   why a restarted watchdog does not re-announce a disruption it already announced.
 * - The all-clear waits for the recovery to hold, using `stabilitaetEndeAm()` — the same function
 *   the customer path uses. A database that flaps would otherwise produce a ticket series.
 * - An outage that recovers *before* it ever alarmed leaves no trace at all: nothing was said, so
 *   there is nothing to take back.
 *
 * `alertId` is only consumed when a new episode begins; the caller generates one per tick, which
 * keeps this function free of randomness and therefore properly testable.
 */
export function notfallSchritt(
	episode: NotfallEpisode | null,
	dbErreichbar: boolean,
	fristen: NotfallFristen,
	alertId: string,
	jetzt: Date
): NotfallSchritt {
	if (!dbErreichbar) {
		if (episode === null) {
			return {
				episode: {
					alertId,
					seitAm: jetzt.toISOString(),
					alarmiertAm: null,
					beendetAm: null
				},
				aktion: 'nichts',
				meldung: null
			};
		}

		// The database answered once and is gone again before the all-clear was due: the recovery did
		// not hold, so this is the same disruption continuing — not a new one (CONTEXT
		// „Entwarnungs-Stabilität", one level down).
		if (episode.beendetAm !== null) {
			return { episode: { ...episode, beendetAm: null }, aktion: 'nichts', meldung: null };
		}

		if (episode.alarmiertAm !== null) return { episode, aktion: 'nichts', meldung: null };

		const faellig = new Date(new Date(episode.seitAm).getTime() + fristen.stalenessSekunden * 1000);
		if (faellig > jetzt) return { episode, aktion: 'nichts', meldung: null };

		const alarmiert = { ...episode, alarmiertAm: jetzt.toISOString() };
		return { episode: alarmiert, aktion: 'alarm', meldung: alarmiert };
	}

	if (episode === null) return { episode: null, aktion: 'nichts', meldung: null };

	// Nothing was ever announced, so nothing is owed — the outage stayed inside its window.
	if (episode.alarmiertAm === null) return { episode: null, aktion: 'nichts', meldung: null };

	if (episode.beendetAm === null) {
		return {
			episode: { ...episode, beendetAm: jetzt.toISOString() },
			aktion: 'nichts',
			meldung: null
		};
	}

	const entwarnungAb = stabilitaetEndeAm(new Date(episode.beendetAm), fristen.stabilitaetSekunden);
	if (entwarnungAb > jetzt) return { episode, aktion: 'nichts', meldung: null };

	return { episode: null, aktion: 'entwarnung', meldung: episode };
}

/**
 * The emergency episode as an ordinary alarm payload.
 *
 * Built through `baueEreignis()` like every other event, so the correlation key, the Rückverweis and
 * the ticket semantics come out identical to a self-alarm that went the normal way — a receiver
 * cannot tell (and must not have to tell) that this one travelled without a database.
 *
 * The Alarmgrund is `fehler_gemeldet`: an unreachable database is a named fault, not a silence.
 * The recovery is `beweis` — the database answering again is the evidence, nothing else is needed.
 */
export function notfallEreignis(
	kern: CacheKern,
	episode: NotfallEpisode,
	ereignis: AlarmEreignis,
	basisUrl: string
): AlarmEreignisDaten {
	const begonnenAm = new Date(episode.seitAm);
	const beendetAm = episode.beendetAm === null ? null : new Date(episode.beendetAm);

	const sicht: EpisodenSicht = {
		alertId: episode.alertId,
		vorgaengerAlertId: null,
		alarmgrund: 'fehler_gemeldet',
		begonnenAm,
		letztesVorkommenAm: beendetAm ?? begonnenAm,
		vorkommen: 1,
		verschaerftAm: null,
		beendetAm,
		erholungsArt: beendetAm === null ? null : 'beweis',
		monitor: {
			art: 'selbst',
			id: kern.id,
			bezeichnung: kern.bezeichnung,
			schluessel: kern.schluessel
		},
		kunde: null
	};

	return baueEreignis(sicht, ereignis, basisUrl);
}

/**
 * Sends one emergency event to the cached webhook receivers.
 *
 * **Webhook only, deliberately.** Autotask's idempotency and ticket state live in
 * `ticket_korrelation` — in the database that is by definition unreachable — so firing blind at it
 * would risk a fresh ticket on every restart. The webhook is at-least-once by contract and carries
 * the `alert_id` a receiver de-dupes on. An instance with no webhook receiver and no Heartbeat-Ping
 * therefore cannot observe a database outage at all, which is why the settings page says so.
 *
 * Returns how many receivers accepted it. Failures are logged, never thrown: the next tick tries
 * again, and the cache still says the alarm has been announced, so nothing is duplicated.
 */
export async function sendeNotfall(
	ziele: readonly CacheZiel[],
	daten: AlarmEreignisDaten,
	port: WebhookPort,
	jetzt: Date
): Promise<number> {
	let zugestellt = 0;

	for (const ziel of ziele) {
		try {
			// Serialised once and used twice — the bytes that are signed are the bytes that go out.
			const rumpf = koerper(daten, jetzt);
			const antwort = await port.sende(ziel.url, rumpf, {
				'Content-Type': 'application/json',
				[SIGNATUR_KOPF]: signiere(ziel.secret, rumpf),
				'X-Nightwatch-Event': daten.ereignis,
				'User-Agent': `Nightwatch/${env.appVersion}`
			});

			if (antwort.status >= 200 && antwort.status < 300) {
				zugestellt++;
				continue;
			}

			log.warn('Notfall-Zustellung abgelehnt', {
				ziel: ziel.id,
				alertId: daten.alertId,
				status: antwort.status
			});
		} catch (err: unknown) {
			log.warn('Notfall-Zustellung fehlgeschlagen', {
				ziel: ziel.id,
				alertId: daten.alertId,
				error: describeError(err)
			});
		}
	}

	return zugestellt;
}
