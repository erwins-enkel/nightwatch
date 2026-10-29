import { fail, type Actions } from '@sveltejs/kit';
import { verschluessele } from '$lib/server/crypto';
import { createLogger, describeError } from '$lib/server/logger';
import { setzeSelbstParameter, speicherePingKonfig, systemStatus } from '$lib/server/selbst/db';
import { ganzzahlOderNull, text } from '$lib/server/zuordnung/formular';
import type { PageServerLoad } from './$types';

const log = createLogger('web');

/**
 * Self-monitoring settings (SPEC §8, §9).
 *
 * „Nicht anlegbar, nicht löschbar, nicht pausierbar (Parameter ja, Existenz nein)" (CONTEXT
 * „Selbst-Monitor") — so this page has exactly two actions, and neither of them creates or destroys
 * anything. The self-monitors come into existence with the instance and with each mailbox.
 *
 * The status half is what the system banner (#31) will show; until it exists, this page is where an
 * operator can see whether Nightwatch is watching itself, and whether anyone would notice if it
 * stopped.
 */

export const load: PageServerLoad = async () => ({ status: await systemStatus() });

function abgelehnt(fehler: Record<string, string>) {
	return { fehler };
}

export const actions: Actions = {
	/** Staleness and Entwarnungs-Stabilität of one self-monitor. Its existence is not on offer. */
	parameter: async ({ request }) => {
		const daten = await request.formData();
		const id = text(daten, 'id');
		if (id === '') return fail(400, abgelehnt({ formular: 'unbekannt' }));

		const staleness = ganzzahlOderNull(text(daten, 'stalenessSekunden'));
		const stabilitaet = text(daten, 'entwarnungsStabilitaetSekunden');

		const fehler: Record<string, string> = {};
		// Staleness is `NOT NULL` with a `> 0` CHECK: an empty field is not „the default", it is a
		// monitor that could never become disturbed.
		if (staleness === undefined || staleness === null) fehler.stalenessSekunden = 'zahl';

		// The stability override is genuinely optional — empty means „use the instance default" —
		// and zero is a legitimate value: announce every recovery immediately.
		const stabilitaetWert = stabilitaet === '' ? null : Number(stabilitaet);
		if (stabilitaetWert !== null && (!Number.isInteger(stabilitaetWert) || stabilitaetWert < 0)) {
			fehler.entwarnungsStabilitaetSekunden = 'zahl';
		}

		if (Object.keys(fehler).length > 0) return fail(400, abgelehnt(fehler));

		try {
			await setzeSelbstParameter(id, staleness as number, stabilitaetWert);
		} catch (err: unknown) {
			log.warn('Selbst-Monitor-Parameter speichern fehlgeschlagen', {
				error: describeError(err)
			});
			return fail(400, abgelehnt({ formular: 'speichern' }));
		}

		return { erfolg: 'gespeichert' as const };
	},

	/**
	 * The Heartbeat-Ping (CONTEXT): opt-in, and switched off by clearing the URL.
	 *
	 * The URL is a secret at rest (SPEC §12) — it usually carries a token in its path — so it is
	 * never sent back to the browser and an empty field means „keep what is stored", exactly like
	 * every other credential field in this application.
	 */
	ping: async ({ request }) => {
		const daten = await request.formData();
		const roh = text(daten, 'url');
		const intervall = ganzzahlOderNull(text(daten, 'intervallSekunden'));
		const abschalten = text(daten, 'abschalten') === 'true';

		const fehler: Record<string, string> = {};
		if (intervall === undefined || intervall === null) fehler.intervallSekunden = 'zahl';

		let url: URL | null = null;
		if (!abschalten && roh !== '') {
			try {
				url = new URL(roh);
			} catch {
				fehler.url = 'url';
			}
			// HTTP is allowed here without an opt-in, unlike a webhook target: this call carries no
			// payload at all, and the receiver is very often an RMM on the operator's own LAN.
			if (url !== null && url.protocol !== 'https:' && url.protocol !== 'http:') {
				fehler.url = 'schema';
			}
		}

		if (Object.keys(fehler).length > 0) return fail(400, abgelehnt(fehler));

		try {
			await speicherePingKonfig(
				abschalten ? null : url === null ? undefined : verschluessele(url.href),
				intervall as number
			);
		} catch (err: unknown) {
			log.warn('Heartbeat-Ping speichern fehlgeschlagen', { error: describeError(err) });
			return fail(400, abgelehnt({ formular: 'speichern' }));
		}

		return { erfolg: abschalten ? ('abgeschaltet' as const) : ('gespeichert' as const) };
	}
};
