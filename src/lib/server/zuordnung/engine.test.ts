import { describe, expect, it } from 'vitest';
import { baueMerkmalIndex, bestimmeKunde, type MerkmalZeile, type ZuordnungsMail } from './engine';
import type { ZuordnungsStufe } from '../db/schema/enums';

let zaehler = 0;

function merkmal(
	kundeId: string,
	stufe: ZuordnungsStufe,
	wert: string,
	extra: Partial<MerkmalZeile> = {}
): MerkmalZeile {
	// Aufsteigende IDs, damit „das kleinste gewinnt" prüfbar ist.
	zaehler += 1;
	return {
		id: `m${String(zaehler).padStart(3, '0')}`,
		kundeId,
		kundeName: `Kunde ${kundeId.toUpperCase()}`,
		kundeArchiviert: false,
		stufe,
		wert,
		...extra
	};
}

function mail(teile: Partial<ZuordnungsMail> = {}): ZuordnungsMail {
	return {
		absender: 'reports@veeam.example',
		empfaenger: ['noc@msp.example'],
		betreff: 'Backup Report',
		bodyText: null,
		...teile
	};
}

describe('Kunden-Zuordnung: First-Match', () => {
	/**
	 * Die Kern-Zusage von SPEC §4: feste globale Priorität, kein Scoring. Kunde B hätte auf Stufe ③
	 * getroffen, aber Stufe ① ist schon fertig — und zwar ohne Abwägung.
	 */
	it('lässt die Plus-Adresse gegen ein Absender-Merkmal eines anderen Kunden gewinnen', () => {
		const index = baueMerkmalIndex([
			merkmal('a', 'plus_adresse', 'noc+kundea@msp.example'),
			merkmal('b', 'absender', 'veeam.example')
		]);

		const ergebnis = bestimmeKunde(mail({ empfaenger: ['noc+kundea@msp.example'] }), index);

		expect(ergebnis).toMatchObject({ art: 'kunde', stufe: 'plus_adresse' });
		expect(ergebnis.art === 'kunde' && ergebnis.merkmal.kundeId).toBe('a');
	});

	it('lässt das Inhaltsmuster gegen den Absender gewinnen', () => {
		const index = baueMerkmalIndex([
			merkmal('a', 'inhaltsmuster', 'k-4711'),
			merkmal('b', 'absender', 'veeam.example')
		]);

		const ergebnis = bestimmeKunde(mail({ betreff: 'Report für K-4711' }), index);

		expect(ergebnis).toMatchObject({ art: 'kunde', stufe: 'inhaltsmuster' });
	});

	it('fällt auf den Absender zurück, wenn die höheren Stufen nichts treffen', () => {
		const index = baueMerkmalIndex([merkmal('b', 'absender', 'veeam.example')]);

		expect(bestimmeKunde(mail(), index)).toMatchObject({ art: 'kunde', stufe: 'absender' });
	});

	it('meldet „kein Kunde", wenn keine Stufe trifft — es gibt keinen Default-Kunden', () => {
		const index = baueMerkmalIndex([merkmal('a', 'absender', 'andere.example')]);

		expect(bestimmeKunde(mail(), index)).toEqual({ art: 'kein_kunde' });
	});

	it('meldet „kein Kunde", wenn überhaupt keine Merkmale gepflegt sind', () => {
		expect(bestimmeKunde(mail(), baueMerkmalIndex([]))).toEqual({ art: 'kein_kunde' });
	});
});

describe('Kunden-Zuordnung: Mehrdeutigkeit', () => {
	it('meldet mehrdeutig, wenn zwei Kunden auf derselben Stufe treffen', () => {
		const index = baueMerkmalIndex([
			merkmal('a', 'absender', 'veeam.example'),
			merkmal('b', 'absender', 'reports@veeam.example')
		]);

		const ergebnis = bestimmeKunde(mail(), index);

		expect(ergebnis.art).toBe('mehrdeutig');
		expect(ergebnis.art === 'mehrdeutig' && ergebnis.kandidaten.map((k) => k.kundeId)).toEqual([
			'a',
			'b'
		]);
	});

	/**
	 * Der Kunde ist eindeutig, nur der Grund ist doppelt — das ist keine Mehrdeutigkeit. Sonst
	 * würde ein Kunde mit gepflegter Adresse *und* Domain seines Lieferanten in der Triage landen.
	 */
	it('ist nicht mehrdeutig, wenn zwei Merkmale desselben Kunden treffen', () => {
		const zuerst = merkmal('a', 'absender', 'veeam.example');
		const danach = merkmal('a', 'absender', 'reports@veeam.example');
		const ergebnis = bestimmeKunde(mail(), baueMerkmalIndex([danach, zuerst]));

		expect(ergebnis).toMatchObject({ art: 'kunde' });
		// Das kleinste Merkmal gewinnt, unabhängig von der Zeilenreihenfolge.
		expect(ergebnis.art === 'kunde' && ergebnis.merkmal.id).toBe(zuerst.id);
	});

	/**
	 * Nach einer Mehrdeutigkeit auf Stufe ① darf nicht auf Stufe ③ weitergesucht werden: aus
	 * „zwei Kunden beanspruchen die Mail" würde sonst still „irgendein anderer Kunde bekommt sie".
	 */
	it('sucht nach einer Mehrdeutigkeit nicht auf der nächsten Stufe weiter', () => {
		const index = baueMerkmalIndex([
			merkmal('a', 'plus_adresse', 'noc+kundea@msp.example'),
			merkmal('b', 'plus_adresse', 'noc+kundea@msp.example'),
			merkmal('c', 'absender', 'veeam.example')
		]);

		const ergebnis = bestimmeKunde(mail({ empfaenger: ['noc+kundea@msp.example'] }), index);

		expect(ergebnis).toMatchObject({ art: 'mehrdeutig', stufe: 'plus_adresse' });
	});
});

describe('Stufe ①: Plus-Adresse', () => {
	it('trifft auf jeder Empfängeradresse, nicht nur der ersten', () => {
		const index = baueMerkmalIndex([merkmal('a', 'plus_adresse', 'noc+kundea@msp.example')]);
		const treffer = bestimmeKunde(
			mail({ empfaenger: ['team@msp.example', 'noc+kundea@msp.example'] }),
			index
		);

		expect(treffer).toMatchObject({ art: 'kunde' });
	});

	it('trifft nicht auf die Basis-Adresse ohne Tag', () => {
		const index = baueMerkmalIndex([merkmal('a', 'plus_adresse', 'noc+kundea@msp.example')]);

		expect(bestimmeKunde(mail({ empfaenger: ['noc@msp.example'] }), index)).toEqual({
			art: 'kein_kunde'
		});
	});
});

describe('Stufe ②: Kundennummer / Inhaltsmuster', () => {
	it('trifft im Betreff und im Body', () => {
		const index = baueMerkmalIndex([merkmal('a', 'inhaltsmuster', 'k-4711')]);

		expect(bestimmeKunde(mail({ betreff: 'Job K-4711 ok' }), index)).toMatchObject({
			art: 'kunde'
		});
		expect(
			bestimmeKunde(mail({ betreff: 'Job ok', bodyText: 'Kundennummer: K-4711' }), index)
		).toMatchObject({ art: 'kunde' });
	});

	/**
	 * Der teuerste Fehler der Zuordnung ist ein Ticket beim falschen Kunden — `k-1234` darf
	 * `k-12345` nicht treffen.
	 */
	it('trifft nur an Token-Grenzen', () => {
		const index = baueMerkmalIndex([merkmal('a', 'inhaltsmuster', 'k-1234')]);

		expect(bestimmeKunde(mail({ betreff: 'Job K-12345 ok' }), index)).toEqual({
			art: 'kein_kunde'
		});
		expect(bestimmeKunde(mail({ betreff: 'Job (K-1234) ok' }), index)).toMatchObject({
			art: 'kunde'
		});
	});

	/** Die Grenze prüft Unicode-Klassen, nicht `\b` — sonst scheitert jedes Merkmal mit Umlaut. */
	it('trifft auch bei Nicht-ASCII-Werten', () => {
		const index = baueMerkmalIndex([merkmal('a', 'inhaltsmuster', 'müller gmbh')]);

		expect(bestimmeKunde(mail({ bodyText: 'Standort Müller GmbH, Halle 3' }), index)).toMatchObject(
			{ art: 'kunde' }
		);
		expect(bestimmeKunde(mail({ bodyText: 'Müller GmbHX' }), index)).toEqual({ art: 'kein_kunde' });
	});

	it('trifft über einen Zeilenumbruch hinweg, weil der Inhalt gefaltet wird', () => {
		const index = baueMerkmalIndex([merkmal('a', 'inhaltsmuster', 'kunde a gmbh')]);

		expect(bestimmeKunde(mail({ bodyText: 'für Kunde A\n  GmbH erstellt' }), index)).toMatchObject({
			art: 'kunde'
		});
	});

	it('behandelt Sonderzeichen im Wert als Text, nicht als Regex', () => {
		const index = baueMerkmalIndex([merkmal('a', 'inhaltsmuster', 'k.4711')]);

		expect(bestimmeKunde(mail({ betreff: 'Job k.4711' }), index)).toMatchObject({ art: 'kunde' });
		// Wäre der Punkt ein Regex-Platzhalter, träfe auch dies.
		expect(bestimmeKunde(mail({ betreff: 'Job kx4711' }), index)).toEqual({ art: 'kein_kunde' });
	});
});

describe('Stufe ③: Absender', () => {
	it('trifft auf die vollständige Adresse', () => {
		const index = baueMerkmalIndex([merkmal('a', 'absender', 'reports@veeam.example')]);

		expect(bestimmeKunde(mail(), index)).toMatchObject({ art: 'kunde' });
	});

	it('trifft auf die Domain', () => {
		const index = baueMerkmalIndex([merkmal('a', 'absender', 'veeam.example')]);

		expect(bestimmeKunde(mail(), index)).toMatchObject({ art: 'kunde' });
	});

	/** Bewusst eng: eine Subdomain still mitzunehmen wäre die teure Richtung des Über-Treffens. */
	it('trifft nicht auf eine Subdomain der gepflegten Domain', () => {
		const index = baueMerkmalIndex([merkmal('a', 'absender', 'veeam.example')]);

		expect(bestimmeKunde(mail({ absender: 'reports@srv1.veeam.example' }), index)).toEqual({
			art: 'kein_kunde'
		});
	});

	it('trifft nichts, wenn Graph keinen Absender geliefert hat', () => {
		const index = baueMerkmalIndex([merkmal('a', 'absender', 'veeam.example')]);

		expect(bestimmeKunde(mail({ absender: '' }), index)).toEqual({ art: 'kein_kunde' });
	});
});

describe('Archivierte Kunden', () => {
	/** CONTEXT „Archiviert": die Zuordnungs-Merkmale greifen weiter, damit Rest-Mails nicht in die Triage fluten. */
	it('ordnen weiterhin zu — was daraus folgt, entscheidet der Aufrufer', () => {
		const index = baueMerkmalIndex([
			merkmal('a', 'absender', 'veeam.example', { kundeArchiviert: true })
		]);

		const ergebnis = bestimmeKunde(mail(), index);

		expect(ergebnis).toMatchObject({ art: 'kunde' });
		expect(ergebnis.art === 'kunde' && ergebnis.merkmal.kundeArchiviert).toBe(true);
	});
});
