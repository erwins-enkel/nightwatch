/**
 * Das Austauschformat der Regel-Vorlagen, ohne Datenbank.
 *
 * Zwei Zusagen werden hier festgenagelt. Die erste ist die aus SPEC §12: **eine Vorlage kann kein
 * Geheimnis tragen** — der Prüfer baut ein neues Objekt aus einer Positivliste, und was nicht auf
 * ihr steht, überlebt den Import nicht. Die zweite ist, dass die **mitgelieferten** Vorlagen
 * dieselbe Prüfung bestehen wie eine importierte Datei: ein kaputter Release-Datensatz fällt damit
 * hier auf und nicht beim Betreiber.
 */
import { describe, expect, it } from 'vitest';
import { KURATIERTE_VORLAGEN } from './kuratiert';
import {
	VORLAGEN_FORMAT,
	alsDatei,
	liesVorlagenDatei,
	vorlageAlsRegel,
	type VorlagenEintrag
} from './vorlage';

const GUELTIG: VorlagenEintrag = {
	schluessel: 'acme-report',
	name: 'ACME — Report',
	version: 1,
	vorgeschlageneArt: 'heartbeat',
	absender: [],
	betreffMuster: ['^ACME Report'],
	schluesselwoerter: [],
	musterSchlecht: ['failed'],
	musterGut: ['success'],
	parameterDefaults: { karenzSekunden: 900 }
};

const datei = (vorlagen: unknown[]) => ({ format: VORLAGEN_FORMAT, vorlagen });

/** Die Fehlerschlüssel eines abgelehnten Ergebnisses, für kurze Zusicherungen. */
function fehler(roh: unknown): string[] {
	const ergebnis = liesVorlagenDatei(roh);
	return ergebnis.art === 'ungueltig' ? ergebnis.fehler.map((eintrag) => eintrag.schluessel) : [];
}

describe('liesVorlagenDatei', () => {
	it('nimmt eine gültige Datei an', () => {
		const ergebnis = liesVorlagenDatei(datei([GUELTIG]));

		expect(ergebnis).toEqual({ art: 'ok', vorlagen: [GUELTIG] });
	});

	it('weist an, was keine Datei ist', () => {
		expect(fehler(null)).toEqual(['kein_objekt']);
		expect(fehler([GUELTIG])).toEqual(['kein_objekt']);
		expect(fehler({ format: 99, vorlagen: [GUELTIG] })).toEqual(['format_unbekannt']);
		expect(fehler(datei([]))).toEqual(['keine_vorlagen']);
	});

	it('besteht auf Schlüssel, Name und einem Match-Kriterium', () => {
		expect(fehler(datei([{ ...GUELTIG, schluessel: '' }]))).toEqual(['schluessel_fehlt']);
		expect(fehler(datei([{ ...GUELTIG, schluessel: 'Groß Geschrieben' }]))).toEqual([
			'schluessel_ungueltig'
		]);
		expect(fehler(datei([{ ...GUELTIG, name: '  ' }]))).toEqual(['name_fehlt']);
		expect(fehler(datei([{ ...GUELTIG, betreffMuster: [] }]))).toEqual(['kein_match_kriterium']);
	});

	it('erkennt denselben Schlüssel zweimal', () => {
		expect(fehler(datei([GUELTIG, GUELTIG]))).toEqual(['schluessel_doppelt']);
	});

	it('weist ein Muster ab, das kein regulärer Ausdruck ist', () => {
		expect(fehler(datei([{ ...GUELTIG, musterSchlecht: ['('] }]))).toEqual(['muster_ungueltig']);
	});

	it('weist eine unbekannte Monitor-Art und unmögliche Parameter ab', () => {
		expect(fehler(datei([{ ...GUELTIG, vorgeschlageneArt: 'orakel' }]))).toEqual(['art_unbekannt']);
		expect(fehler(datei([{ ...GUELTIG, parameterDefaults: { karenzSekunden: -1 } }]))).toEqual([
			'parameter_ungueltig'
		]);
		expect(
			fehler(datei([{ ...GUELTIG, parameterDefaults: { erwartungPlan: { wochentage: [9] } } }]))
		).toEqual(['parameter_ungueltig']);
	});

	it('sammelt die Fehler aller Einträge statt beim ersten aufzuhören', () => {
		expect(
			fehler(
				datei([
					{ ...GUELTIG, name: '' },
					{ ...GUELTIG, schluessel: 'zweiter', musterGut: ['('] }
				])
			)
		).toEqual(['name_fehlt', 'muster_ungueltig']);
	});

	/** SPEC §12: „Export/Import von Regel-Vorlagen enthält nie Credentials." */
	it('lässt jedes Feld fallen, das nicht zum Format gehört', () => {
		const ergebnis = liesVorlagenDatei(
			datei([
				{
					...GUELTIG,
					autotaskSecret: 'geheim',
					herkunft: 'kuratiert',
					id: '00000000-0000-0000-0000-000000000000'
				}
			])
		);

		expect(ergebnis.art).toBe('ok');
		if (ergebnis.art !== 'ok') return;
		expect(Object.keys(ergebnis.vorlagen[0]).sort()).toEqual(Object.keys(GUELTIG).sort());
	});
});

describe('alsDatei', () => {
	it('ist mit dem Leser rundlauffähig', () => {
		const ausgabe = alsDatei([GUELTIG]);

		expect(liesVorlagenDatei(JSON.parse(JSON.stringify(ausgabe)))).toEqual({
			art: 'ok',
			vorlagen: [GUELTIG]
		});
	});

	it('nimmt Datenbank-Spalten nicht mit in den Export', () => {
		const ausgabe = alsDatei([
			{ ...GUELTIG, id: 'x', herkunft: 'eigen' } as unknown as VorlagenEintrag
		]);

		expect(ausgabe.vorlagen[0]).not.toHaveProperty('id');
		expect(ausgabe.vorlagen[0]).not.toHaveProperty('herkunft');
	});
});

describe('vorlageAlsRegel', () => {
	it('reicht genau die fünf Regel-Felder durch', () => {
		expect(vorlageAlsRegel(GUELTIG)).toEqual({
			absender: [],
			betreffMuster: ['^ACME Report'],
			schluesselwoerter: [],
			musterSchlecht: ['failed'],
			musterGut: ['success']
		});
	});
});

describe('kuratierte Vorlagen', () => {
	it('bestehen dieselbe Prüfung wie ein Import', () => {
		expect(liesVorlagenDatei(datei(KURATIERTE_VORLAGEN)).art).toBe('ok');
	});

	it('tragen alle einen Hersteller und eine Beschreibung mit Quelle', () => {
		for (const vorlage of KURATIERTE_VORLAGEN) {
			expect(vorlage.hersteller, vorlage.schluessel).toBeTruthy();
			expect(vorlage.beschreibung?.length ?? 0, vorlage.schluessel).toBeGreaterThan(40);
		}
	});

	/**
	 * Die Muster sind gegen echte Betreffzeilen geschrieben; hier steht je Vorlage eine, damit ein
	 * späteres „nur schnell das Muster schärfen" nicht unbemerkt die Erkennung verliert.
	 */
	it('treffen die Betreffzeilen, für die sie gemacht sind', () => {
		const proben: Record<string, { schlecht: string; gut: string }> = {
			'veeam-backup-report': {
				schlecht: '[Failed] Daily Backup (3 instances)',
				gut: '[Success] Daily Backup (3 instances)'
			},
			'nagios-service-alert': {
				schlecht: '** PROBLEM Service Alert: fileserver/PING is CRITICAL **',
				gut: '** RECOVERY Service Alert: fileserver/PING is OK **'
			},
			'zabbix-problem': {
				schlecht: 'Problem: Free disk space is less than 10%',
				gut: 'Resolved: Free disk space is less than 10%'
			}
		};

		for (const vorlage of KURATIERTE_VORLAGEN) {
			const probe = proben[vorlage.schluessel];
			expect(probe, `keine Probe für ${vorlage.schluessel}`).toBeDefined();

			const trifft = (muster: string[], betreff: string) =>
				muster.some((eintrag) => new RegExp(eintrag, 'i').test(betreff));

			expect(trifft(vorlage.betreffMuster, probe.schlecht), vorlage.schluessel).toBe(true);
			expect(trifft(vorlage.betreffMuster, probe.gut), vorlage.schluessel).toBe(true);
			expect(trifft(vorlage.musterSchlecht, probe.schlecht), vorlage.schluessel).toBe(true);
			expect(trifft(vorlage.musterGut, probe.gut), vorlage.schluessel).toBe(true);
			// Kein Slot darf die Gegenprobe treffen — sonst klassifizierte die Regel jede Mail als
			// Fehler oder jede als OK.
			expect(trifft(vorlage.musterSchlecht, probe.gut), vorlage.schluessel).toBe(false);
			expect(trifft(vorlage.musterGut, probe.schlecht), vorlage.schluessel).toBe(false);
		}
	});
});
