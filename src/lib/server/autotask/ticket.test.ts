/**
 * Was Autotask zu sehen bekommt — ohne Netz und ohne Datenbank.
 *
 * Zwei Dinge tragen hier echte Last: die 50-Zeichen-Grenze von `externalID`, an der die ganze
 * De-Dupe hängt, und `istUnberuehrt` — die einzige Bedingung, unter der Nightwatch ein Ticket
 * automatisch zumacht.
 */
import { describe, expect, it } from 'vitest';
import { baueEreignis, type EpisodenSicht } from '../alarm/ereignis';
import type { AutotaskTicketDefaults } from '../db/schema/system';
import { externId, istUnberuehrt, notizFuer, notizKoerper, ticketKoerper } from './ticket';

const BASIS = 'https://nightwatch.msp.example';

const KONFIG: AutotaskTicketDefaults = {
	statusId: 1,
	priorityId: 2,
	queueId: 8,
	abschlussStatusId: 5,
	notizTypId: 1,
	notizPublishId: 1,
	faelligkeitStunden: 24
};

const JETZT = new Date('2026-07-28T06:10:00Z');

function sicht(teile: Partial<EpisodenSicht> = {}): EpisodenSicht {
	return {
		alertId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
		vorgaengerAlertId: null,
		alarmgrund: 'ueberfaellig',
		begonnenAm: new Date('2026-07-28T04:00:00Z'),
		letztesVorkommenAm: new Date('2026-07-28T06:00:00Z'),
		vorkommen: 3,
		verschaerftAm: null,
		beendetAm: null,
		erholungsArt: null,
		monitor: {
			art: 'heartbeat',
			id: '11111111-1111-1111-1111-111111111111',
			bezeichnung: 'Veeam Nachtlauf'
		},
		kunde: { id: '33333333-3333-3333-3333-333333333333', name: 'Kunde A' },
		...teile
	};
}

const alarm = baueEreignis(sicht(), 'alarm', BASIS);

describe('externalID', () => {
	const key = alarm.korrelationsKey;

	it('passt in die 50 Zeichen, die Autotask hergibt', () => {
		// Der volle Key ist deutlich länger — genau deshalb gibt es diese Abbildung.
		expect(key.length).toBeGreaterThan(50);
		expect(externId(key).length).toBeLessThanOrEqual(50);
	});

	it('ist über Läufe stabil', () => {
		expect(externId(key)).toBe(externId(key));
	});

	it('behält das Präfix, das den Selbst-Monitor vom Kunden trennt', () => {
		expect(externId('nw:monitor:alert')).toMatch(/^nw:/);
		expect(externId('self:kern:alert')).toMatch(/^self:/);
		expect(externId('self:kern:alert').length).toBeLessThanOrEqual(50);
	});

	it('trennt tausend Keys ohne Kollision', () => {
		const werte = new Set(
			Array.from({ length: 1000 }, (_, nummer) => externId(`nw:monitor-${nummer}:alert-${nummer}`))
		);
		expect(werte.size).toBe(1000);
	});
});

describe('Ticket-Körper', () => {
	const koerper = ticketKoerper({
		daten: alarm,
		konfig: KONFIG,
		companyId: 4711,
		externId: externId(alarm.korrelationsKey),
		vorgaengerTicket: null,
		jetzt: JETZT
	});

	it('trägt Company, tenant-IDs und den gekürzten Korrelations-Key', () => {
		expect(koerper.companyID).toBe(4711);
		expect(koerper.status).toBe(1);
		expect(koerper.priority).toBe(2);
		expect(koerper.queueID).toBe(8);
		expect(koerper.externalID).toBe(externId(alarm.korrelationsKey));
	});

	it('rechnet die Fälligkeit aus der Vorgabe', () => {
		expect(koerper.dueDateTime).toBe('2026-07-29T06:10:00.000Z');
	});

	it('lässt weg, was der Tenant nicht verlangt', () => {
		const schlank = ticketKoerper({
			daten: alarm,
			konfig: { statusId: 1, priorityId: 2 },
			companyId: 4711,
			externId: 'nw:x',
			vorgaengerTicket: null,
			jetzt: JETZT
		});

		// Ein explizites null hieße bei Autotask „leeren" — gegen eine Kategorie, die eine Queue
		// verlangt, wäre das ein Fehlschlag statt eines Auslassens.
		expect(schlank).not.toHaveProperty('queueID');
		expect(schlank).not.toHaveProperty('dueDateTime');
		expect(schlank).not.toHaveProperty('billingCodeID');
	});

	it('nennt Kunde, Monitor, Grund und den Rückverweis', () => {
		const text = String(koerper.description);
		expect(text).toContain('Kunde A');
		expect(text).toContain('Veeam Nachtlauf');
		expect(text).toContain('expected mail overdue');
		expect(text).toContain(`${BASIS}/monitore/${alarm.monitor.id}`);
		expect(text).toContain(alarm.alertId);
	});

	it('führt beim Re-Alarm nach Schließung den Vorgänger mit', () => {
		const reAlarm = baueEreignis(
			sicht({ vorgaengerAlertId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }),
			'alarm',
			BASIS
		);
		const text = String(
			ticketKoerper({
				daten: reAlarm,
				konfig: KONFIG,
				companyId: 4711,
				externId: 'nw:x',
				vorgaengerTicket: 'T20260728.0001',
				jetzt: JETZT
			}).description
		);

		expect(text).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
		expect(text).toContain('T20260728.0001');
	});
});

describe('Notizen', () => {
	it('erklärt beim Alarm, warum kein zweites Ticket entstand', () => {
		expect(notizFuer(alarm).text).toContain('no second ticket was opened');
	});

	it('nennt die Verschärfung als das, was sie ist', () => {
		const verschaerft = baueEreignis(
			sicht({ alarmgrund: 'fehler_gemeldet', verschaerftAm: new Date('2026-07-28T05:00:00Z') }),
			'verschaerfung',
			BASIS
		);

		expect(notizFuer(verschaerft).titel).toContain('escalated');
		expect(notizFuer(verschaerft).text).toContain('2026-07-28 05:00 UTC');
	});

	it('trägt bei der Entwarnung Anlass, Dauer und Vorkommen (SPEC §6)', () => {
		const entwarnung = baueEreignis(
			sicht({ beendetAm: new Date('2026-07-28T07:12:00Z'), erholungsArt: 'beweis' }),
			'entwarnung',
			BASIS
		);
		const text = notizFuer(entwarnung).text;

		expect(text).toContain('expected mail overdue');
		expect(text).toContain('3 h 12 min');
		expect(text).toContain('Occurrences: 3');
		expect(text).toContain('evidence-based');
	});

	it('sagt bei nicht-beweisbasierter Erholung, wie sie zustande kam', () => {
		const erledigt = baueEreignis(
			sicht({ beendetAm: new Date('2026-07-28T04:30:00Z'), erholungsArt: 'erledigt' }),
			'entwarnung',
			BASIS
		);

		expect(notizFuer(erledigt).text).toContain('marked done by hand');
		expect(notizFuer(erledigt).text).toContain('30 min');
	});

	it('setzt die tenant-spezifischen Notiz-IDs', () => {
		const koerper = notizKoerper('12345', notizFuer(alarm), KONFIG);
		expect(koerper.ticketID).toBe(12345);
		expect(koerper.noteType).toBe(1);
		expect(koerper.publish).toBe(1);
	});
});

describe('Unberührtes Ticket', () => {
	it('erkennt das Ticket im Anlage-Status ohne Bearbeiter', () => {
		expect(istUnberuehrt({ status: 1, assignedResourceID: null }, KONFIG)).toBe(true);
		expect(istUnberuehrt({ status: 1 }, KONFIG)).toBe(true);
		// Autotask liefert „kein Bearbeiter" je nach Feld auch als 0.
		expect(istUnberuehrt({ status: 1, assignedResourceID: 0 }, KONFIG)).toBe(true);
	});

	it('hält jedes berührte Ticket offen', () => {
		expect(istUnberuehrt({ status: 8, assignedResourceID: null }, KONFIG)).toBe(false);
		expect(istUnberuehrt({ status: 1, assignedResourceID: 42 }, KONFIG)).toBe(false);
		expect(istUnberuehrt(null, KONFIG)).toBe(false);
	});

	it('schließt nichts, solange der Anlage-Status unbekannt ist', () => {
		expect(istUnberuehrt({ status: 1, assignedResourceID: null }, {})).toBe(false);
	});
});
