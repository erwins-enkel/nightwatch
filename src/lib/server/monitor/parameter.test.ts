import { describe, expect, it } from 'vitest';
import type { MonitorArt } from '../db/schema/enums';
import type { MonitorParameter } from '../db/schema/monitor';
import {
	AUTO_ZURUECK_DEFAULT_SEKUNDEN,
	MAX_OFFENZEIT_DEFAULT_SEKUNDEN,
	normalisiereParameter,
	normalisiereRegel,
	pruefeMonitor
} from './parameter';
import type { RegelZeile } from './regel';

const MATCH: RegelZeile = {
	absender: ['veeam.test'],
	betreffMuster: [],
	schluesselwoerter: [],
	musterSchlecht: [],
	musterGut: []
};

function pruefe(art: MonitorArt, parameter: MonitorParameter, regel: Partial<RegelZeile> = {}) {
	return pruefeMonitor({
		bezeichnung: 'Backup',
		art,
		parameter,
		regel: { ...MATCH, ...regel }
	});
}

const HEARTBEAT: MonitorParameter = {
	erwartungModus: 'intervall',
	erwartungIntervallSekunden: 300,
	karenzSekunden: 900
};

describe('Parameter je Art', () => {
	it('nimmt einen vollständigen Heartbeat an', () => {
		expect(pruefe('heartbeat', HEARTBEAT)).toEqual([]);
		expect(
			pruefe('heartbeat', {
				erwartungModus: 'kalenderplan',
				erwartungPlan: { wochentage: [1, 2, 3, 4, 5], uhrzeit: '06:00' },
				karenzSekunden: 0
			})
		).toEqual([]);
	});

	it('verlangt Erwartung und Karenz', () => {
		expect(pruefe('heartbeat', { karenzSekunden: 900 })).toContain('erwartung_fehlt');
		expect(pruefe('heartbeat', { erwartungModus: 'intervall', karenzSekunden: 900 })).toContain(
			'erwartung_unvollstaendig'
		);
		expect(pruefe('heartbeat', { ...HEARTBEAT, karenzSekunden: undefined })).toContain(
			'karenz_fehlt'
		);
	});

	it('lehnt einen unsinnigen Kalenderplan ab', () => {
		const fehler = pruefe('heartbeat', {
			erwartungModus: 'kalenderplan',
			erwartungPlan: { wochentage: [0, 8], uhrzeit: '25:00' },
			karenzSekunden: 900
		});
		expect(fehler).toContain('erwartung_unvollstaendig');
	});

	it('verlangt beim Zähler ein Fenster und mindestens eine Grenze', () => {
		expect(pruefe('zaehler', { zaehlerFensterSekunden: 600, zaehlerObergrenze: 50 })).toEqual([]);
		expect(pruefe('zaehler', { zaehlerFensterSekunden: 600 })).toContain('grenze_fehlt');
		expect(pruefe('zaehler', { zaehlerObergrenze: 50 })).toContain('fenster_fehlt');
	});

	/** Eine Obergrenze unter der Untergrenze ließe kein erreichbares Band übrig. */
	it('lehnt ein verdrehtes Band ab', () => {
		const fehler = pruefe('zaehler', {
			zaehlerFensterSekunden: 600,
			zaehlerObergrenze: 3,
			zaehlerUntergrenze: 10
		});
		expect(fehler).toContain('grenzen_verdreht');
	});

	it('meldet jeden Mangel auf einmal', () => {
		const fehler = pruefeMonitor({
			bezeichnung: '  ',
			art: 'zaehler',
			parameter: {},
			regel: { ...MATCH, absender: [] }
		});
		expect(fehler).toEqual(
			expect.arrayContaining([
				'bezeichnung_leer',
				'fenster_fehlt',
				'grenze_fehlt',
				'kein_match_kriterium'
			])
		);
	});
});

describe('Regel', () => {
	it('verlangt mindestens ein Match-Kriterium', () => {
		expect(pruefe('ereignis', {}, { absender: [] })).toContain('kein_match_kriterium');
	});

	it('lehnt ein nicht übersetzbares Muster ab', () => {
		expect(pruefe('heartbeat', HEARTBEAT, { musterSchlecht: ['(unbalanced'] })).toContain(
			'muster_ungueltig'
		);
	});

	/** CONTEXT „Muster-Slots": Ereignis hat kein Fehler-Muster, der Zähler nutzt beide nicht. */
	it('weist Muster in ungenutzten Slots zurück', () => {
		expect(pruefe('ereignis', {}, { musterSchlecht: ['failed'] })).toContain('slot_ungenutzt');
		expect(pruefe('ereignis', {}, { musterGut: ['installed'] })).not.toContain('slot_ungenutzt');
		expect(
			pruefe(
				'zaehler',
				{ zaehlerFensterSekunden: 600, zaehlerObergrenze: 50 },
				{ musterGut: ['x'] }
			)
		).toContain('slot_ungenutzt');
	});

	it('putzt Leerraum und leere Einträge weg', () => {
		const geputzt = normalisiereRegel({
			absender: ['  Reports@Veeam.Test  ', ''],
			betreffMuster: [' Backup ', '   '],
			schluesselwoerter: [],
			musterSchlecht: [],
			musterGut: []
		});

		expect(geputzt.absender).toEqual(['reports@veeam.test']);
		expect(geputzt.betreffMuster).toEqual(['Backup']);
	});
});

describe('Normalisierung', () => {
	/** Ein Art-Wechsel darf kein Fenster einer alten Art mitschleppen (Tabellen-CHECK). */
	it('behält nur die Parameter der eigenen Art', () => {
		const normalisiert = normalisiereParameter('heartbeat', {
			...HEARTBEAT,
			zaehlerFensterSekunden: 600,
			maxOffenzeitSekunden: 900
		});

		expect(normalisiert).toEqual(HEARTBEAT);
	});

	it('setzt die dokumentierten Defaults', () => {
		expect(normalisiereParameter('ereignis', {}).autoZurueckSekunden).toBe(
			AUTO_ZURUECK_DEFAULT_SEKUNDEN
		);
		expect(normalisiereParameter('paar', {}).maxOffenzeitSekunden).toBe(
			MAX_OFFENZEIT_DEFAULT_SEKUNDEN
		);
	});

	it('wirft die Nutzlast einer nicht gewählten Erwartung weg', () => {
		const normalisiert = normalisiereParameter('heartbeat', {
			erwartungModus: 'intervall',
			erwartungIntervallSekunden: 300,
			erwartungPlan: { wochentage: [1], uhrzeit: '06:00' },
			karenzSekunden: 900
		});

		expect(normalisiert.erwartungPlan).toBeUndefined();
	});
});
