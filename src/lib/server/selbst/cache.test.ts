/**
 * Die Cache-Datei, gegen ein echtes Dateisystem.
 *
 * Drei Zusagen, die nur die Datei selbst beweisen kann: sie ist ohne den Schlüssel unlesbar, sie
 * steht auf `0600`, und ein kaputter Inhalt legt den Watchdog nicht lahm — er wirft ihn weg. Ohne
 * das Erste liegen Webhook-Secrets im Klartext im Volume; ohne das Letzte stirbt genau der Prozess,
 * der den Ausfall melden sollte.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	istUnveraendert,
	leererCache,
	liesCache,
	schreibeCache,
	type WatchdogCache
} from './cache';

let ordner: string;

const SCHLUESSEL = Buffer.alloc(32, 7).toString('base64');

function beispiel(): WatchdogCache {
	return {
		...leererCache('https://nightwatch.msp.test'),
		kern: {
			id: 'kern-id',
			schluessel: 'kern',
			bezeichnung: 'Nightwatch-Kern',
			stalenessSekunden: 900,
			stabilitaetSekunden: 600
		},
		webhookZiele: [{ id: 'z1', url: 'https://rmm.msp.test/hook', secret: 'streng-geheim' }],
		notfall: null
	};
}

describe('Watchdog-Cache', () => {
	beforeAll(async () => {
		process.env.NIGHTWATCH_SECRET_KEY = SCHLUESSEL;
		ordner = await mkdtemp(join(tmpdir(), 'nightwatch-cache-'));
	});

	afterAll(async () => {
		await rm(ordner, { recursive: true, force: true });
	});

	it('gibt nach einem Round-Trip denselben Inhalt zurück', async () => {
		const datei = join(ordner, 'roundtrip', 'cache.enc');
		const cache = beispiel();

		await schreibeCache(datei, cache);
		const gelesen = await liesCache(datei);

		// `geschriebenAm` wird beim Schreiben gestempelt; alles andere muss identisch sein.
		expect(gelesen).not.toBeNull();
		expect({ ...gelesen, geschriebenAm: '' }).toEqual({ ...cache, geschriebenAm: '' });
	});

	/** SPEC §12: das Secret darf im Volume nicht lesbar herumliegen. */
	it('legt nichts im Klartext ab', async () => {
		const datei = join(ordner, 'geheim.enc');
		await schreibeCache(datei, beispiel());

		const roh = await readFile(datei, 'utf8');
		expect(roh).not.toContain('streng-geheim');
		expect(roh).not.toContain('rmm.msp.test');
		expect(roh.startsWith('v1.')).toBe(true);
	});

	it('schreibt die Datei mit 0600', async () => {
		const datei = join(ordner, 'rechte.enc');
		await schreibeCache(datei, beispiel());

		expect((await stat(datei)).mode & 0o777).toBe(0o600);
	});

	/** Ein Neustart mitten im Schreiben darf keinen halben Cache hinterlassen. */
	it('lässt keine temporäre Datei liegen', async () => {
		const datei = join(ordner, 'atomar.enc');
		await schreibeCache(datei, beispiel());

		await expect(stat(`${datei}.tmp`)).rejects.toThrow();
	});

	it('verwirft eine unlesbare Datei, statt zu werfen', async () => {
		const datei = join(ordner, 'kaputt.enc');
		await writeFile(datei, 'kein gültiger Chiffretext');

		await expect(liesCache(datei)).resolves.toBeNull();
	});

	it('verwirft einen Cache aus einer anderen Version', async () => {
		const datei = join(ordner, 'alt.enc');
		await schreibeCache(datei, { ...beispiel(), version: 99 });

		await expect(liesCache(datei)).resolves.toBeNull();
	});

	it('gibt für eine fehlende Datei null zurück', async () => {
		await expect(liesCache(join(ordner, 'gibtesnicht.enc'))).resolves.toBeNull();
	});

	describe('Änderungserkennung', () => {
		it('ignoriert den Schreib-Zeitstempel', () => {
			const a = { ...beispiel(), geschriebenAm: '2026-07-29T06:00:00.000Z' };
			const b = { ...beispiel(), geschriebenAm: '2026-07-29T06:00:30.000Z' };

			expect(istUnveraendert(a, b)).toBe(true);
		});

		it('erkennt einen geänderten Notfall-Zustand', () => {
			const vorher = beispiel();
			const nachher = {
				...vorher,
				notfall: { alertId: 'a', seitAm: 'x', alarmiertAm: null, beendetAm: null }
			};

			expect(istUnveraendert(vorher, nachher)).toBe(false);
		});

		it('erkennt ein neues Webhook-Ziel', () => {
			const vorher = beispiel();
			const nachher = { ...vorher, webhookZiele: [] };

			expect(istUnveraendert(vorher, nachher)).toBe(false);
		});

		it('behandelt „noch kein Cache" als Änderung', () => {
			expect(istUnveraendert(null, beispiel())).toBe(false);
		});
	});
});
