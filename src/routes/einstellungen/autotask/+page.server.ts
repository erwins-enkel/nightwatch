import { fail, type Actions } from '@sveltejs/kit';
import {
	entschluesseleZugang,
	erzeugeAutotaskPort,
	holeZoneUrl,
	type AutotaskPort
} from '$lib/server/autotask/client';
import {
	holeKonfig,
	istEinsatzbereit,
	speichereDefaults,
	speichereZugang,
	setzeZoneUrl
} from '$lib/server/autotask/db';
import { lesePicklist, type PicklistWert } from '$lib/server/autotask/felder';
import { verschluessele } from '$lib/server/crypto';
import type { AutotaskTicketDefaults } from '$lib/server/db/schema/system';
import { createLogger, describeError } from '$lib/server/logger';
import { ganzzahlOderNull, text } from '$lib/server/zuordnung/formular';
import type { PageServerLoad } from './$types';

const log = createLogger('web');

/**
 * The Autotask settings (SPEC §7, §9): access, zone and the tenant-specific IDs.
 *
 * The page deliberately does two round trips to Autotask on load — the picklists behind
 * status/priority/queue and the note fields. Resolving them here is what keeps every numeric ID out
 * of the source: the operator picks a label, Nightwatch stores the tenant's number.
 */

export interface Picklisten {
	status: PicklistWert[];
	prioritaet: PicklistWert[];
	queue: PicklistWert[];
	arbeitstyp: PicklistWert[];
	notizTyp: PicklistWert[];
	notizPublish: PicklistWert[];
}

async function holePicklisten(port: AutotaskPort): Promise<Picklisten> {
	const [tickets, notizen] = await Promise.all([
		port.anfrage('GET', 'Tickets/entityInformation/fields'),
		port.anfrage('GET', 'TicketNotes/entityInformation/fields')
	]);

	if (tickets.status !== 200 || notizen.status !== 200) {
		throw new Error(`entityInformation antwortete mit HTTP ${tickets.status}/${notizen.status}`);
	}

	return {
		status: lesePicklist(tickets.body, 'status'),
		prioritaet: lesePicklist(tickets.body, 'priority'),
		queue: lesePicklist(tickets.body, 'queueID'),
		arbeitstyp: lesePicklist(tickets.body, 'billingCodeID'),
		notizTyp: lesePicklist(notizen.body, 'noteType'),
		notizPublish: lesePicklist(notizen.body, 'publish')
	};
}

export const load: PageServerLoad = async () => {
	const konfig = await holeKonfig();
	const zugang = entschluesseleZugang(konfig);

	let picklisten: Picklisten | null = null;
	let picklistenFehler: string | null = null;

	if (zugang) {
		try {
			picklisten = await holePicklisten(erzeugeAutotaskPort(zugang));
		} catch (err: unknown) {
			// The page stays usable on plain number inputs — an unreachable PSA must not lock the
			// operator out of the very form that fixes the credentials.
			picklistenFehler = describeError(err);
			log.warn('Autotask-Picklisten nicht ladbar', { error: picklistenFehler });
		}
	}

	return {
		aktiv: konfig.aktiv,
		zoneUrl: konfig.zoneUrl,
		benutzer: konfig.benutzer,
		// SPEC §12: the credentials themselves never reach a client, not even masked.
		secretGespeichert: konfig.secretChiffre !== null,
		integrationCodeGespeichert: konfig.integrationCodeChiffre !== null,
		einsatzbereit: istEinsatzbereit(konfig),
		defaults: konfig.defaults,
		picklisten,
		picklistenFehler
	};
};

/** Keeps every failure's `fehler` the same shape, like the other settings forms. */
function abgelehnt(fehler: Record<string, string>, benutzer = '') {
	return { fehler, eingaben: { benutzer } };
}

const ID_FELDER = [
	['statusId', 'statusId'],
	['priorityId', 'priorityId'],
	['queueId', 'queueId'],
	['abschlussStatusId', 'abschlussStatusId'],
	['arbeitstypId', 'arbeitstypId'],
	['notizTypId', 'notizTypId'],
	['notizPublishId', 'notizPublishId'],
	['faelligkeitStunden', 'faelligkeitStunden']
] as const;

export const actions: Actions = {
	zugang: async ({ request }) => {
		const daten = await request.formData();
		const benutzer = text(daten, 'benutzer');
		const secret = text(daten, 'secret');
		const integrationCode = text(daten, 'integrationCode');
		const aktiv = text(daten, 'aktiv') === 'true';

		const konfig = await holeKonfig();
		const fehler: Record<string, string> = {};
		if (benutzer === '') fehler.benutzer = 'pflicht';
		// An empty field means "keep what is stored" — a credential is never round-tripped through
		// the browser, so the form cannot echo it back for editing.
		if (secret === '' && konfig.secretChiffre === null) fehler.secret = 'pflicht';
		if (integrationCode === '' && konfig.integrationCodeChiffre === null) {
			fehler.integrationCode = 'pflicht';
		}
		if (Object.keys(fehler).length > 0) return fail(400, abgelehnt(fehler, benutzer));

		try {
			await speichereZugang({
				benutzer,
				secretChiffre: secret === '' ? null : verschluessele(secret),
				integrationCodeChiffre: integrationCode === '' ? null : verschluessele(integrationCode),
				aktiv
			});
		} catch (err: unknown) {
			log.warn('Autotask-Zugang speichern fehlgeschlagen', { error: describeError(err) });
			return fail(400, abgelehnt({ formular: 'speichern' }, benutzer));
		}

		return { erfolg: 'gespeichert' as const };
	},

	/** Research-Doc §1: the zone is resolved once and then persisted, never looked up per call. */
	zone: async () => {
		const konfig = await holeKonfig();
		if (!konfig.benutzer) return fail(400, abgelehnt({ formular: 'zone_ohne_benutzer' }));

		try {
			await setzeZoneUrl(await holeZoneUrl(konfig.benutzer));
		} catch (err: unknown) {
			log.warn('Zonen-Ermittlung fehlgeschlagen', { error: describeError(err) });
			return fail(400, abgelehnt({ formular: 'zone' }));
		}

		return { erfolg: 'zone' as const };
	},

	vorgaben: async ({ request }) => {
		const daten = await request.formData();

		const defaults: AutotaskTicketDefaults = {};
		const fehler: Record<string, string> = {};

		for (const [feld, schluessel] of ID_FELDER) {
			const wert = ganzzahlOderNull(text(daten, feld));
			if (wert === undefined) fehler[feld] = 'zahl';
			else if (wert !== null) defaults[schluessel] = wert;
		}

		if (Object.keys(fehler).length > 0) return fail(400, abgelehnt(fehler));

		await speichereDefaults(defaults);
		return { erfolg: 'gespeichert' as const };
	}
};
