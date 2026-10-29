import {
	ladeOffeneZustellungen,
	markiereFehlgeschlagen,
	oeffneZustellungen,
	type ZustellEintrag
} from '../alarm/db';
import type { AlarmEreignisDaten } from '../alarm/ereignis';
import { fuehreAus as fuehreAutotaskAus } from '../autotask/ablauf';
import { entschluesseleZugang, erzeugeAutotaskPort, type AutotaskPort } from '../autotask/client';
import { holeKonfig, istEinsatzbereit } from '../autotask/db';
import type { AutotaskTicketDefaults } from '../db/schema/system';
import { getDb } from '../db/client';
import { createLogger, describeError } from '../logger';
import { fuehreAus as fuehreWebhookAus } from '../webhook/ablauf';
import { erzeugeWebhookPort, type WebhookPort } from '../webhook/client';
import { aktiveZiele } from '../webhook/db';
import type { Tx } from '../zuordnung/db';

/**
 * The watchdog's own send path (SPEC §8): „Watchdog sendet direkt an die bestehenden Alarmwege —
 * eigener Sende-Pfad ohne worker/pg-boss."
 *
 * „Eigener Pfad" means the *transport* is its own, not the logic. The two channel flows are the
 * same functions the queue workers call; all that changes is who calls them and what retries them.
 * A queue would buy nothing here anyway: pg-boss lives in the very database whose failure the
 * watchdog exists to survive.
 */

const log = createLogger('selbst');

/** Delivery targets served per tick. Self-monitors are few; this is a backstop, not a budget. */
const ZIELE_PRO_TICK = 50;

/**
 * Attempts before a delivery is given up on — the same budget the queue workers grant a customer
 * alarm (`autotask/worker.ts` → `VERSUCHE`), so a self-alarm is not treated as less important.
 */
export const SELBST_MAX_VERSUCHE = 8;

export interface VersandPorts {
	webhook: WebhookPort;
	/** Null while Autotask is switched off, incompletely configured, or has no self-monitor company. */
	autotask: AutotaskPort | null;
	autotaskDefaults: AutotaskTicketDefaults;
}

/**
 * Builds the ports once per tick, the same way `autotask/worker.ts` builds them per job: read the
 * configuration, decrypt the access, create the client. Doing it per tick rather than per delivery
 * keeps one decryption out of every row while still picking up a settings change within a tick.
 */
export async function baueVersandPorts(db = getDb()): Promise<VersandPorts> {
	const konfig = await holeKonfig(db);

	// Decryption is not a database operation, and the caller treats every throw as „Postgres is
	// gone". A rotated or mistyped `NIGHTWATCH_SECRET_KEY` would otherwise make the watchdog
	// announce a database outage that is not happening — a self-monitor lying about itself is the
	// one failure mode this whole feature cannot afford. An unreadable access is simply no access.
	let zugang: ReturnType<typeof entschluesseleZugang> = null;
	try {
		zugang = entschluesseleZugang(konfig);
	} catch (err: unknown) {
		log.warn('Autotask-Zugang nicht entschlüsselbar', { error: describeError(err) });
	}

	// „Wohin sein Ticket geht, ist reine Transport-Konfiguration" (CONTEXT): without a nominated
	// company a self-alarm has no Autotask address, and the channel is simply off for it.
	const einsatzbereit =
		zugang !== null && istEinsatzbereit(konfig) && konfig.defaults.selbstCompanyId !== undefined;

	return {
		webhook: erzeugeWebhookPort(),
		autotask: einsatzbereit && zugang !== null ? erzeugeAutotaskPort(zugang) : null,
		autotaskDefaults: konfig.defaults
	};
}

/**
 * Which deliveries a self-monitor event wants — the watchdog's counterpart to `Alarmweg.plane()`.
 *
 * Runs inside the publishing transaction, so a receiver switched off in the same moment either gets
 * the event or does not, and never leaves a ledger row nobody wanted.
 *
 * The conditions mirror the two `weg.ts` modules exactly: every active webhook receiver, and
 * Autotask only when the instance is ready **and** a self-monitor company is nominated.
 */
export async function planeSelbstZustellungen(tx: Tx): Promise<ZustellEintrag[]> {
	const eintraege: ZustellEintrag[] = [];

	for (const ziel of await aktiveZiele(tx)) {
		eintraege.push({ kanal: 'webhook', webhookZielId: ziel.id });
	}

	const konfig = await holeKonfig(tx);
	if (istEinsatzbereit(konfig) && konfig.defaults.selbstCompanyId !== undefined) {
		eintraege.push({ kanal: 'autotask', webhookZielId: null });
	}

	return eintraege;
}

/** Writes the ledger rows for one published self-monitor event, in the publisher's transaction. */
export async function oeffneSelbstZustellungen(
	uebergangId: string,
	ereignis: AlarmEreignisDaten['ereignis'],
	tx: Tx
): Promise<number> {
	const eintraege = await planeSelbstZustellungen(tx);
	await oeffneZustellungen(uebergangId, ereignis, eintraege, tx);
	return eintraege.length;
}

/**
 * Executes the open self-monitor deliveries, synchronously.
 *
 * **A delivery whose episode is still open is never dead-lettered.** That is what makes the core's
 * recovery observable at all: the pending self-alarm is the one thing that keeps knocking on a
 * receiver no customer event happens to be going to, and its eventual success is the evidence
 * `zustellStoerungSeit()` reads. Give up on it after eight ticks and the core could never learn that
 * the channel came back — it would owe an Entwarnung forever. The budget therefore applies only to
 * deliveries of an episode that has already ended (in practice the Entwarnung, which nobody needs
 * chased indefinitely). The operator's way out of a permanently dead receiver is to deactivate it,
 * which `webhook/ablauf.ts` settles as „nothing owed".
 */
export async function sendeOffene(ports: VersandPorts, jetzt: Date, db = getDb()): Promise<number> {
	const koepfe = await ladeOffeneZustellungen(ZIELE_PRO_TICK, 'selbst', db);
	let gesendet = 0;

	for (const kopf of koepfe) {
		const autotask = ports.autotask;

		try {
			if (kopf.kanal === 'webhook') {
				await fuehreWebhookAus({ zustellungId: kopf.id, port: ports.webhook, jetzt, db });
			} else if (autotask === null) {
				// Not an attempt: the operator switched Autotask off, has not finished configuring it,
				// or nominated no company for self-monitor tickets. Leaving the row untouched keeps
				// `versuche` intact, so a paused integration cannot push a self-alarm into the dead
				// letter while nobody was even trying to send it.
				continue;
			} else {
				await fuehreAutotaskAus({
					zustellungId: kopf.id,
					port: autotask,
					konfig: ports.autotaskDefaults,
					jetzt,
					db
				});
			}
			gesendet++;
		} catch (err: unknown) {
			// Both flows already recorded the diagnosis on the row; all that is left is whether this
			// delivery has run out of road.
			const aufgeben = !kopf.episodeOffen && kopf.versuche + 1 >= SELBST_MAX_VERSUCHE;
			if (aufgeben) {
				await markiereFehlgeschlagen(kopf.id, jetzt, db);
				log.error('Selbst-Zustellung aufgegeben', {
					zustellungId: kopf.id,
					kanal: kopf.kanal,
					alertId: kopf.episode.alertId,
					versuche: kopf.versuche + 1
				});
			} else {
				log.warn('Selbst-Zustellung fehlgeschlagen', {
					zustellungId: kopf.id,
					kanal: kopf.kanal,
					alertId: kopf.episode.alertId,
					versuche: kopf.versuche + 1,
					error: describeError(err)
				});
			}
		}
	}

	return gesendet;
}
