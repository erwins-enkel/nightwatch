import { describe, expect, it } from 'vitest';
import { normalisiereWert, pruefeWert } from './merkmal';

describe('Merkmal-Normalisierung', () => {
	it('trimmt, faltet Innen-Whitespace und schreibt klein', () => {
		expect(normalisiereWert('inhaltsmuster', '  Kunde   A\tGmbH ')).toBe('kunde a gmbh');
	});

	it('entfernt beim Absender ein führendes @, damit @acme.com und acme.com ein Merkmal sind', () => {
		expect(normalisiereWert('absender', '@ACME.com')).toBe('acme.com');
	});

	it('lässt ein @ mitten in der Adresse stehen', () => {
		expect(normalisiereWert('absender', 'Alerts@Acme.com')).toBe('alerts@acme.com');
	});
});

describe('Merkmal-Validierung', () => {
	it('lehnt Leerwerte auf jeder Stufe ab', () => {
		expect(pruefeWert('plus_adresse', '')).toBe('leer');
		expect(pruefeWert('inhaltsmuster', '')).toBe('leer');
		expect(pruefeWert('absender', '')).toBe('leer');
	});

	it('nimmt eine Plus-Adresse an', () => {
		expect(pruefeWert('plus_adresse', 'noc+kundea@example.com')).toBeNull();
	});

	/**
	 * Der wichtigste Test der Datei: ohne das erzwungene `+` könnte die gemeinsame NOC-Adresse als
	 * Stufe-①-Merkmal eingetragen werden und würde jede eingehende Mail einem Kunden zuschlagen —
	 * ein Default-Kunde durch die Hintertür, den CONTEXT bewusst ausschließt.
	 */
	it('lehnt eine Adresse ohne Plus-Teil ab', () => {
		expect(pruefeWert('plus_adresse', 'noc@example.com')).toBe('plus_adresse');
	});

	it('lehnt ein Plus ohne Tag an beiden Enden ab', () => {
		expect(pruefeWert('plus_adresse', 'noc+@example.com')).toBe('plus_adresse');
		expect(pruefeWert('plus_adresse', '+kundea@example.com')).toBe('plus_adresse');
	});

	it('lehnt ein Inhaltsmuster unter drei Zeichen ab, weil es fast jede Mail trifft', () => {
		expect(pruefeWert('inhaltsmuster', 'ab')).toBe('zu_kurz');
		expect(pruefeWert('inhaltsmuster', 'k-1')).toBeNull();
	});

	it('nimmt beim Absender Adresse und Domain an', () => {
		expect(pruefeWert('absender', 'alerts@acme.com')).toBeNull();
		expect(pruefeWert('absender', 'acme.com')).toBeNull();
		expect(pruefeWert('absender', 'mail.acme.co.uk')).toBeNull();
	});

	it('lehnt beim Absender einen Wert ohne Punkt und ohne @ ab', () => {
		expect(pruefeWert('absender', 'acme')).toBe('absender');
	});
});
