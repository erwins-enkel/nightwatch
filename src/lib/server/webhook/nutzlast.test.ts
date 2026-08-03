/**
 * Das Drahtformat — selbsttragend, für beide Monitor-Formen, ohne Datenbank.
 *
 * Was hier steht, ist die Zusage an jeden Empfänger: dieselben Feldnamen, dieselben Typen, ein
 * Zeitstempel je Versuch — und ein Körper, der genau einmal serialisiert wird.
 */
import { describe, expect, it } from 'vitest';
import { baueEreignis, type EpisodenSicht, type EreignisMonitor } from '../alarm/ereignis';
import { koerper, nutzlast } from './nutzlast';

const BASIS = 'https://nightwatch.msp.example';
const GESENDET = new Date('2026-07-28T07:00:00Z');

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
		letztesVorkommenAm: new Date('2026-07-28T06:40:00Z'),
		vorkommen: 3,
		verschaerftAm: null,
		beendetAm: null,
		erholungsArt: null,
		monitor: kundenMonitor,
		kunde: { id: '33333333-3333-3333-3333-333333333333', name: 'Kunde A' },
		...teile
	};
}

describe('Nutzlast', () => {
	it('trägt den Alarm eines Kunden-Monitors vollständig', () => {
		const daten = baueEreignis(sicht(), 'alarm', BASIS);

		expect(nutzlast(daten, GESENDET)).toEqual({
			ereignis: 'alarm',
			alert_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
			vorgaenger_alert_id: null,
			gesendet_am: '2026-07-28T07:00:00.000Z',
			weisung: 'eroeffnen',
			monitor: {
				art: 'heartbeat',
				id: kundenMonitor.id,
				bezeichnung: 'Veeam Nachtlauf'
			},
			kunde: { id: '33333333-3333-3333-3333-333333333333', name: 'Kunde A' },
			alarmgrund: 'ueberfaellig',
			erholungs_art: null,
			vorkommen: {
				anzahl: 3,
				erste_am: '2026-07-28T06:10:00.000Z',
				letzte_am: '2026-07-28T06:40:00.000Z',
				verschaerft_am: null,
				stoerungsdauer_sekunden: null
			},
			rueckverweis: `${BASIS}/monitore/${kundenMonitor.id}`
		});
	});

	/** SPEC §7: „Selbst-Monitor-Events tragen `monitor.art = "selbst"`, `kunde = null`." */
	it('kennzeichnet Selbst-Monitore und lässt den Kunden leer', () => {
		const daten = baueEreignis(sicht({ monitor: selbstMonitor, kunde: null }), 'alarm', BASIS);
		const gebaut = nutzlast(daten, GESENDET);

		expect(gebaut.monitor).toEqual({
			art: 'selbst',
			id: selbstMonitor.id,
			bezeichnung: 'Nightwatch-Kern',
			schluessel: 'kern'
		});
		expect(gebaut.kunde).toBeNull();
		expect(gebaut.rueckverweis).toBe(`${BASIS}/system`);
	});

	/** Die Entwarnung ist das einzige Ereignis, das die volle Zusammenfassung tragen kann. */
	it('fasst eine beendete Episode mit Dauer und Verschärfung zusammen', () => {
		const daten = baueEreignis(
			sicht({
				verschaerftAm: new Date('2026-07-28T06:20:00Z'),
				beendetAm: new Date('2026-07-28T06:40:00Z'),
				erholungsArt: 'beweis',
				vorgaengerAlertId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
			}),
			'entwarnung',
			BASIS
		);
		const gebaut = nutzlast(daten, GESENDET);

		expect(gebaut.weisung).toBe('schliessen');
		expect(gebaut.erholungs_art).toBe('beweis');
		expect(gebaut.vorgaenger_alert_id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
		expect(gebaut.vorkommen.verschaerft_am).toBe('2026-07-28T06:20:00.000Z');
		expect(gebaut.vorkommen.stoerungsdauer_sekunden).toBe(1800);
	});

	/**
	 * Der Zeitstempel gehört zum Versuch, nicht zum Ereignis: nur so kann ein Empfänger ein
	 * Zeitfenster prüfen, ohne den legitimen Retry einer Stunde später zu verwerfen.
	 */
	it('stempelt jeden Versuch neu', () => {
		const daten = baueEreignis(sicht(), 'alarm', BASIS);
		const spaeter = new Date(GESENDET.getTime() + 3_600_000);

		expect(nutzlast(daten, GESENDET).gesendet_am).not.toBe(nutzlast(daten, spaeter).gesendet_am);
		// Die Identität bleibt trotzdem dieselbe — daran erkennt der Empfänger den Retry.
		expect(nutzlast(daten, spaeter).alert_id).toBe(daten.alertId);
	});

	it('serialisiert genau das, was die Nutzlast sagt', () => {
		const daten = baueEreignis(sicht(), 'alarm', BASIS);

		expect(JSON.parse(koerper(daten, GESENDET))).toEqual(nutzlast(daten, GESENDET));
	});
});
