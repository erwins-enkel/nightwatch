import { describe, expect, it } from 'vitest';
import {
	anzeigeZustand,
	baueKarten,
	LEERER_FILTER,
	type BoardFilter,
	type BoardMonitorZeile,
	type KundenZeile
} from './filter';

const JETZT = new Date('2026-07-30T08:00:00Z');
const AKTIV = new Date('2026-07-01T00:00:00Z');

let laufendeNummer = 0;

function zeile(teile: Partial<BoardMonitorZeile> = {}): BoardMonitorZeile {
	laufendeNummer += 1;
	return {
		id: `m${laufendeNummer}`,
		kundeId: 'k1',
		bezeichnung: 'Veeam Tagesreport',
		art: 'heartbeat',
		zustand: 'gesund',
		alarmgrund: null,
		pausiert: false,
		pausiertBis: null,
		zustandSeit: AKTIV,
		aktiviertAm: AKTIV,
		zuletztGesehenAm: null,
		...teile
	};
}

function kunde(teile: Partial<KundenZeile> = {}): KundenZeile {
	return {
		id: 'k1',
		name: 'Stadtwerke Nettetal',
		kundennummer: 'K-1042',
		autotaskCompanyId: null,
		...teile
	};
}

function filter(teile: Partial<BoardFilter> = {}): BoardFilter {
	return { ...LEERER_FILTER, ...teile };
}

describe('Anzeige-Zustand', () => {
	it('nennt einen unbestätigten Monitor Entwurf, egal was sonst an ihm steht', () => {
		const entwurf = zeile({
			aktiviertAm: null,
			zustand: 'gestoert',
			alarmgrund: 'ueberfaellig',
			pausiert: true
		});
		expect(anzeigeZustand(entwurf, JETZT)).toBe('entwurf');
	});

	/**
	 * CONTEXT „Pausiert" ist ein Overlay: die Episode bleibt offen und steht in der Alarm-Leiste.
	 * Ein „pausiert"-Abzeichen würde eine laufende Störung verstecken.
	 */
	it('zeigt eine Störung auch dann, wenn der Monitor pausiert ist', () => {
		const gestoert = zeile({ zustand: 'gestoert', alarmgrund: 'unklar', pausiert: true });
		expect(anzeigeZustand(gestoert, JETZT)).toBe('gestoert');
	});

	it('zeigt die Pause nur, solange sie wirkt', () => {
		const laufend = zeile({ pausiert: true, pausiertBis: new Date('2026-07-30T12:00:00Z') });
		const abgelaufen = zeile({ pausiert: true, pausiertBis: new Date('2026-07-30T07:00:00Z') });

		expect(anzeigeZustand(laufend, JETZT)).toBe('pausiert');
		expect(anzeigeZustand(abgelaufen, JETZT)).toBe('gesund');
	});

	it('behandelt eine Pause ohne Ende als offen', () => {
		expect(anzeigeZustand(zeile({ pausiert: true }), JETZT)).toBe('pausiert');
	});
});

describe('Kunden-Karten', () => {
	it('zählt die Monitore je Abzeichen und summiert auf die Gesamtzahl', () => {
		const zeilen = [
			zeile({ zustand: 'gestoert', alarmgrund: 'ueberfaellig' }),
			zeile({ zustand: 'gestoert', alarmgrund: 'unklar', pausiert: true }),
			zeile({ pausiert: true }),
			zeile({ aktiviertAm: null }),
			zeile()
		];

		const [karte] = baueKarten([kunde()], zeilen, LEERER_FILTER, JETZT);

		expect(karte.zaehler).toEqual({ gestoert: 2, pausiert: 1, entwurf: 1, gesund: 1 });
		expect(karte.gesamt).toBe(5);
	});

	it('nimmt für die Ampel das Schlimmste, was der Kunde zu bieten hat', () => {
		const gestoert = [zeile({ zustand: 'gestoert', alarmgrund: 'unklar' }), zeile()];
		const pausiert = [zeile({ pausiert: true }), zeile()];
		const entwurf = [zeile({ aktiviertAm: null })];

		expect(baueKarten([kunde()], gestoert, LEERER_FILTER, JETZT)[0].ampel).toBe('gestoert');
		expect(baueKarten([kunde()], pausiert, LEERER_FILTER, JETZT)[0].ampel).toBe('pausiert');
		expect(baueKarten([kunde()], entwurf, LEERER_FILTER, JETZT)[0].ampel).toBe('entwurf');
	});

	it('zeigt einen Kunden ohne Monitore — genau das ist ein blinder Fleck', () => {
		const [karte] = baueKarten([kunde()], [], LEERER_FILTER, JETZT);

		expect(karte.gesamt).toBe(0);
		expect(karte.ampel).toBe('entwurf');
	});

	/** Die Zusammenfassung gehört dem Kunden, nicht dem Filter. */
	it('lässt Ampel und Zähler vom Filter unberührt', () => {
		const zeilen = [zeile({ zustand: 'gestoert', alarmgrund: 'ueberfaellig' }), zeile(), zeile()];

		const [karte] = baueKarten([kunde()], zeilen, filter({ zustand: 'gestoert' }), JETZT);

		expect(karte.ampel).toBe('gestoert');
		expect(karte.zaehler).toEqual({ gestoert: 1, pausiert: 0, entwurf: 0, gesund: 2 });
		expect(karte.treffer).toHaveLength(1);
	});
});

describe('Suche und Filter', () => {
	it('findet den Kunden über Name und Kundennummer, unabhängig von der Schreibweise', () => {
		const zeilen = [zeile()];

		expect(baueKarten([kunde()], zeilen, filter({ suche: 'NETTETAL' }), JETZT)).toHaveLength(1);
		expect(baueKarten([kunde()], zeilen, filter({ suche: 'k-1042' }), JETZT)).toHaveLength(1);
		expect(baueKarten([kunde()], zeilen, filter({ suche: 'huber' }), JETZT)).toHaveLength(0);
	});

	it('nimmt bei einem Treffer auf den Kunden alle seine Monitore mit', () => {
		const zeilen = [zeile({ bezeichnung: 'Veeam' }), zeile({ bezeichnung: 'Sophos' })];

		const [karte] = baueKarten([kunde()], zeilen, filter({ suche: 'nettetal' }), JETZT);

		expect(karte.treffer.map((monitor) => monitor.bezeichnung)).toEqual(['Veeam', 'Sophos']);
	});

	it('findet den Kunden auch über den Namen eines seiner Monitore', () => {
		const zeilen = [zeile({ bezeichnung: 'Veeam Tagesreport' }), zeile({ bezeichnung: 'Sophos' })];

		const [karte] = baueKarten([kunde()], zeilen, filter({ suche: 'veeam' }), JETZT);

		expect(karte.treffer.map((monitor) => monitor.bezeichnung)).toEqual(['Veeam Tagesreport']);
	});

	it('filtert nach Monitor-Art', () => {
		const zeilen = [zeile({ art: 'heartbeat' }), zeile({ art: 'zaehler' })];

		const [karte] = baueKarten([kunde()], zeilen, filter({ art: 'zaehler' }), JETZT);

		expect(karte.treffer.map((monitor) => monitor.art)).toEqual(['zaehler']);
	});

	/**
	 * Die eine bewusste Asymmetrie zum Abzeichen: wer nach „pausiert" fragt, meint die Wartung —
	 * auch an einem Monitor, der dabei gestört ist und deshalb das Störungs-Abzeichen trägt.
	 */
	it('findet unter „pausiert" auch die gestörten Monitore in Wartung', () => {
		const zeilen = [
			zeile({ zustand: 'gestoert', alarmgrund: 'unklar', pausiert: true }),
			zeile({ pausiert: true }),
			zeile()
		];

		const [karte] = baueKarten([kunde()], zeilen, filter({ zustand: 'pausiert' }), JETZT);

		expect(karte.treffer).toHaveLength(2);
	});

	/** Der Struktur-Filter ist strenger als die Suche: er ist die eigentliche Frage. */
	it('verwirft einen namentlich passenden Kunden ohne passenden Monitor', () => {
		const zeilen = [zeile()];

		const karten = baueKarten(
			[kunde()],
			zeilen,
			filter({ suche: 'nettetal', zustand: 'gestoert' }),
			JETZT
		);

		expect(karten).toHaveLength(0);
	});

	it('verwirft einen Kunden ohne Monitore, sobald ein Struktur-Filter gesetzt ist', () => {
		expect(baueKarten([kunde()], [], filter({ art: 'paar' }), JETZT)).toHaveLength(0);
		expect(baueKarten([kunde()], [], LEERER_FILTER, JETZT)).toHaveLength(1);
	});

	it('ordnet die Monitore ihren Kunden zu', () => {
		const kunden = [kunde(), kunde({ id: 'k2', name: 'Huber KG', kundennummer: null })];
		const zeilen = [
			zeile({ kundeId: 'k1', bezeichnung: 'Veeam' }),
			zeile({ kundeId: 'k2', bezeichnung: 'Sophos' }),
			zeile({ kundeId: 'k2', bezeichnung: 'APC USV' })
		];

		const karten = baueKarten(kunden, zeilen, LEERER_FILTER, JETZT);

		expect(karten.map((karte) => karte.gesamt)).toEqual([1, 2]);
	});
});
