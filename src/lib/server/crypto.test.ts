import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { entschluessele, requireSecretKey, secretHinweis, verschluessele } from './crypto';

const key = randomBytes(32);

describe('Secrets at rest (SPEC §12)', () => {
	const urspruenglich = process.env.NIGHTWATCH_SECRET_KEY;
	afterEach(() => {
		if (urspruenglich === undefined) delete process.env.NIGHTWATCH_SECRET_KEY;
		else process.env.NIGHTWATCH_SECRET_KEY = urspruenglich;
	});

	it('gibt den Klartext unverändert zurück', () => {
		const geheim = 'Abc~123!ü€ mit Leerzeichen';
		expect(entschluessele(verschluessele(geheim, key), key)).toBe(geheim);
	});

	it('erzeugt für denselben Klartext zwei verschiedene Chiffren', () => {
		// Ohne frisches IV je Aufruf verriete die Chiffre, dass zwei Postfächer dasselbe Secret
		// benutzen — und genau das ist beim Multi-Tenant-App-Modell der Normalfall.
		expect(verschluessele('gleich', key)).not.toBe(verschluessele('gleich', key));
	});

	it('lehnt eine manipulierte Chiffre ab, statt Müll zu liefern', () => {
		const [prefix, iv, tag, chiffre] = verschluessele('geheim', key).split('.');
		const verdreht = Buffer.from(chiffre, 'base64');
		verdreht[0] ^= 0xff;

		expect(() =>
			entschluessele([prefix, iv, tag, verdreht.toString('base64')].join('.'), key)
		).toThrow();
	});

	it('lehnt einen falschen Schlüssel ab', () => {
		expect(() => entschluessele(verschluessele('geheim', key), randomBytes(32))).toThrow();
	});

	it.each([
		['leer', ''],
		['ohne Präfix', 'iv.tag.chiffre'],
		['zu wenige Teile', 'v1.iv.tag'],
		['unbekanntes Präfix', 'v2.aaaa.bbbb.cccc']
	])('lehnt ein kaputtes Format ab (%s)', (_name, kaputt) => {
		expect(() => entschluessele(kaputt, key)).toThrow('Chiffre hat kein bekanntes Format');
	});

	it('nennt den fehlenden Schlüssel beim Namen', () => {
		delete process.env.NIGHTWATCH_SECRET_KEY;
		expect(() => requireSecretKey()).toThrow(/NIGHTWATCH_SECRET_KEY is not set/);
	});

	it('weist einen zu kurzen Schlüssel zurück', () => {
		process.env.NIGHTWATCH_SECRET_KEY = randomBytes(16).toString('base64');
		expect(() => requireSecretKey()).toThrow(/must decode to 32 bytes/);
	});

	it('nimmt den Schlüssel als base64 und als hex', () => {
		const roh = randomBytes(32);

		process.env.NIGHTWATCH_SECRET_KEY = roh.toString('base64');
		expect(requireSecretKey()).toEqual(roh);

		process.env.NIGHTWATCH_SECRET_KEY = roh.toString('hex');
		expect(requireSecretKey()).toEqual(roh);
	});

	it('zeigt höchstens die letzten vier Zeichen und maskiert kurze Secrets ganz', () => {
		expect(secretHinweis('sehr-langes-secret-abcd')).toBe('••••abcd');
		expect(secretHinweis('kurz')).toBe('••••');
	});
});
