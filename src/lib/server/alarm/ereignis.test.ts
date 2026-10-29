/**
 * Der Payload — selbsttragend, für beide Monitor-Formen, ohne Datenbank.
 */
import { describe, expect, it } from 'vitest';
import {
	baueEreignis,
	korrelationsKey,
	rueckverweis,
	type EpisodenSicht,
	type EreignisMonitor
} from './ereignis';

const BASIS = 'https://nightwatch.msp.example';

const kundenMonitor: EreignisMonitor = {
	art: 'heartbeat',
	id: '11111111-1111-1111-1111-111111111111',
	bezeichnung: 'Veeam Nachtlauf'
};

const selbstMonitor: EreignisMonitor = {
	art: 'selbst',
	id: '22222222-2222-2222-2222-222222222222',
	bezeichnung: 'Nightwatch-Kern',
	schluessel: 'kern'
};

function sicht(teile: Partial<EpisodenSicht> = {}): EpisodenSicht {
	return {
		alertId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
		vorgaengerAlertId: null,
		alarmgrund: 'ueberfaellig',
		begonnenAm: new Date('2026-07-28T06:10:00Z'),
		letztesVorkommenAm: new Date('2026-07-28T06:10:00Z'),
		vorkommen: 1,
		verschaerftAm: null,
		beendetAm: null,
		erholungsArt: null,
		monitor: kundenMonitor,
		kunde: { id: '33333333-3333-3333-3333-333333333333', name: 'Kunde A' },
		...teile
	};
}

describe('Korrelations-Key', () => {
	/** SPEC §7 — der Key, der als `externalID` im Ticket landet und Retries idempotent macht. */
	it('trägt die veröffentlichte Episoden-Identität, nicht die interne', () => {
		expect(korrelationsKey(kundenMonitor, 'alert-1')).toBe(`nw:${kundenMonitor.id}:alert-1`);
	});

	it('kennzeichnet Selbst-Monitore über ihren Schlüssel', () => {
		expect(korrelationsKey(selbstMonitor, 'alert-1')).toBe('self:kern:alert-1');
	});
});

describe('Rückverweis', () => {
	it('zeigt auf den auslösenden Monitor', () => {
		expect(rueckverweis(BASIS, kundenMonitor)).toBe(`${BASIS}/monitore/${kundenMonitor.id}`);
	});

	/** Selbst-Monitore haben keine eigene Seite — sie erscheinen als System-Banner. */
	it('führt Selbst-Monitore auf die System-Ansicht', () => {
		expect(rueckverweis(BASIS, selbstMonitor)).toBe(`${BASIS}/system`);
	});

	it('verträgt einen ORIGIN mit Schrägstrich am Ende', () => {
		expect(rueckverweis(`${BASIS}/`, kundenMonitor)).toBe(`${BASIS}/monitore/${kundenMonitor.id}`);
	});
});

describe('Alarm-Ereignis', () => {
	it('trägt alles, was ein Empfänger zum Handeln braucht', () => {
		const ereignis = baueEreignis(sicht(), 'alarm', BASIS);

		expect(ereignis).toMatchObject({
			ereignis: 'alarm',
			alertId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
			vorgaengerAlertId: null,
			korrelationsKey: `nw:${kundenMonitor.id}:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
			weisung: 'eroeffnen',
			alarmgrund: 'ueberfaellig',
			rueckverweis: `${BASIS}/monitore/${kundenMonitor.id}`
		});
		expect(ereignis.kunde).toEqual({ id: '33333333-3333-3333-3333-333333333333', name: 'Kunde A' });
		expect(ereignis.zusammenfassung.vorkommen).toBe(1);
	});

	/** SPEC §7: Selbst-Monitor-Events tragen `monitor.art = "selbst"` und `kunde = null`. */
	it('kennzeichnet Selbst-Monitor-Ereignisse und lässt den Kunden leer', () => {
		const ereignis = baueEreignis(sicht({ monitor: selbstMonitor, kunde: null }), 'alarm', BASIS);

		expect(ereignis.monitor.art).toBe('selbst');
		expect(ereignis.kunde).toBeNull();
		expect(ereignis.korrelationsKey.startsWith('self:')).toBe(true);
	});

	it('nimmt in die Entwarnung Dauer, Vorkommen und Schließ-Erlaubnis mit', () => {
		const ereignis = baueEreignis(
			sicht({
				vorgaengerAlertId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
				vorkommen: 4,
				letztesVorkommenAm: new Date('2026-07-28T06:40:00Z'),
				beendetAm: new Date('2026-07-28T07:10:00Z'),
				erholungsArt: 'beweis'
			}),
			'entwarnung',
			BASIS
		);

		expect(ereignis.weisung).toBe('schliessen');
		expect(ereignis.vorgaengerAlertId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
		expect(ereignis.zusammenfassung).toMatchObject({
			vorkommen: 4,
			stoerungsdauerSekunden: 3600
		});
	});

	/** Auto-Zurück ist kein Beweis — das Ticket wird kommentiert, nicht geschlossen. */
	it('lässt eine Auto-Zurück-Entwarnung nur kommentieren', () => {
		const ereignis = baueEreignis(
			sicht({ beendetAm: new Date('2026-07-29T06:10:00Z'), erholungsArt: 'auto_zurueck' }),
			'entwarnung',
			BASIS
		);

		expect(ereignis.weisung).toBe('kommentieren');
	});
});
