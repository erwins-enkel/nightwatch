import { describe, expect, it } from 'vitest';
import {
	HEUHAUFEN_MAX_LAENGE,
	Heuhaufen,
	kompiliereMuster,
	kompiliereRegel,
	slotTreffer,
	trifftMatchKriterien,
	type RegelMail,
	type RegelZeile
} from './regel';

const LEER: RegelZeile = {
	absender: [],
	betreffMuster: [],
	schluesselwoerter: [],
	musterSchlecht: [],
	musterGut: []
};

function regel(teile: Partial<RegelZeile>) {
	return kompiliereRegel({ ...LEER, ...teile }).regel;
}

function mail(teile: Partial<RegelMail> = {}): RegelMail {
	return {
		absender: 'reports@veeam.test',
		betreff: 'Backup Job 4711 completed',
		bodyText: 'Alle Aufträge erfolgreich.',
		...teile
	};
}

describe('Match-Kriterien', () => {
	it('trifft den Absender als Adresse und als Domain', () => {
		expect(trifftMatchKriterien(mail(), regel({ absender: ['reports@veeam.test'] }))).toBe(true);
		expect(trifftMatchKriterien(mail(), regel({ absender: ['veeam.test'] }))).toBe(true);
		expect(trifftMatchKriterien(mail(), regel({ absender: ['acme.test'] }))).toBe(false);
	});

	it('vergleicht Absender ohne Rücksicht auf Groß-/Kleinschreibung', () => {
		const treffer = trifftMatchKriterien(
			mail({ absender: 'Reports@Veeam.Test' }),
			regel({ absender: ['reports@veeam.test'] })
		);
		expect(treffer).toBe(true);
	});

	/** Dieselbe Software meldet je nach Konfiguration deutsch oder englisch (CONTEXT „Regel"). */
	it('verknüpft innerhalb einer Kategorie mit ODER', () => {
		const kompiliert = regel({ betreffMuster: ['Sicherung', 'Backup'] });
		expect(trifftMatchKriterien(mail(), kompiliert)).toBe(true);
		expect(trifftMatchKriterien(mail({ betreff: 'Sicherung fertig' }), kompiliert)).toBe(true);
		expect(trifftMatchKriterien(mail({ betreff: 'Newsletter' }), kompiliert)).toBe(false);
	});

	it('verknüpft gesetzte Kategorien mit UND', () => {
		const kompiliert = regel({ absender: ['veeam.test'], betreffMuster: ['Backup'] });
		expect(trifftMatchKriterien(mail(), kompiliert)).toBe(true);
		// Absender passt, Betreff nicht — eine Kategorie zu treffen reicht nicht.
		expect(trifftMatchKriterien(mail({ betreff: 'Newsletter' }), kompiliert)).toBe(false);
	});

	it('findet Schlüsselwörter auch im Body und über Zeilenumbrüche hinweg', () => {
		const kompiliert = regel({ schluesselwoerter: ['alle aufträge'] });
		expect(
			trifftMatchKriterien(mail({ bodyText: 'Alle\n   Aufträge erfolgreich.' }), kompiliert)
		).toBe(true);
	});

	/**
	 * Eine Regel ohne Kriterium würde jede Mail ihres Kunden schlucken und alle anderen Monitore
	 * desselben Kunden aushungern.
	 */
	it('trifft nichts, wenn kein Kriterium gesetzt ist', () => {
		expect(trifftMatchKriterien(mail(), regel({}))).toBe(false);
	});

	it('trifft nichts bei leerem Absender', () => {
		expect(trifftMatchKriterien(mail({ absender: '' }), regel({ absender: ['veeam.test'] }))).toBe(
			false
		);
	});
});

describe('Muster-Slots', () => {
	it('meldet beide Slots unabhängig voneinander', () => {
		const kompiliert = regel({ musterSchlecht: ['failed'], musterGut: ['completed'] });

		expect(slotTreffer(mail(), kompiliert)).toEqual({ schlecht: false, gut: true });
		expect(slotTreffer(mail({ betreff: 'Backup failed' }), kompiliert)).toEqual({
			schlecht: true,
			gut: false
		});
		expect(slotTreffer(mail({ betreff: 'Backup failed, retry completed' }), kompiliert)).toEqual({
			schlecht: true,
			gut: true
		});
	});

	it('sucht die Slots auch im Body', () => {
		const kompiliert = regel({ musterSchlecht: ['Fehlercode \\d+'] });
		expect(slotTreffer(mail({ bodyText: 'Fehlercode 42' }), kompiliert).schlecht).toBe(true);
	});
});

describe('Kompilierung', () => {
	it('meldet ungültige Muster, statt die Regel zu verwerfen', () => {
		const { regel: kompiliert, ungueltig } = kompiliereRegel({
			...LEER,
			musterSchlecht: ['failed', '(unbalanced']
		});

		expect(ungueltig).toEqual(['(unbalanced']);
		expect(kompiliert.musterSchlecht).toHaveLength(1);
	});

	it('lehnt maßlos lange Muster ab', () => {
		expect(kompiliereMuster('a'.repeat(10_000))).toBeNull();
	});
});

describe('Heuhaufen', () => {
	it('deckelt die Textmenge, die ein Muster sieht', () => {
		const heuhaufen = new Heuhaufen(mail({ bodyText: 'x'.repeat(HEUHAUFEN_MAX_LAENGE * 2) }));
		expect(heuhaufen.roh).toHaveLength(HEUHAUFEN_MAX_LAENGE);
	});
});
