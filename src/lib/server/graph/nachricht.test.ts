import { describe, expect, it } from 'vitest';
import { htmlZuText, zuMailZeile } from './nachricht';

const nachricht = (rest: Record<string, unknown> = {}) => ({
	id: 'AAMkAGVm-1',
	receivedDateTime: '2026-07-27T05:40:12Z',
	from: { emailAddress: { address: 'Reports@Hersteller.test', name: 'Backup' } },
	toRecipients: [{ emailAddress: { address: 'noc@example.test' } }],
	subject: 'Backup completed',
	...rest
});

describe('HTML→Text (SPEC §11)', () => {
	it('wirft Skript- und Style-Inhalte weg', () => {
		const text = htmlZuText(
			'<style>.a{color:red}</style><p>Backup ok</p><script>alert(1)</script>'
		);
		expect(text).toBe('Backup ok');
	});

	it('macht aus Block-Grenzen Zeilenumbrüche, damit Zeilen matchbar bleiben', () => {
		expect(htmlZuText('<p>Job A: ok</p><p>Job B: failed</p>')).toBe('Job A: ok\nJob B: failed');
		expect(htmlZuText('Zeile 1<br>Zeile 2')).toBe('Zeile 1\nZeile 2');
	});

	it('trennt Tabellenzellen, statt sie zu verkleben', () => {
		expect(htmlZuText('<tr><td>Server1</td><td>OK</td></tr>')).toBe('Server1\tOK');
	});

	it('löst Entities auf', () => {
		expect(htmlZuText('<p>A &amp; B &lt;test&gt; &nbsp;&#39;x&#39; &#x2713;</p>')).toBe(
			"A & B <test> 'x' ✓"
		);
	});

	it('lässt eine unbekannte Entity stehen, statt sie zu verschlucken', () => {
		expect(htmlZuText('<p>100&fooo;</p>')).toBe('100&fooo;');
	});

	it('entfernt Kommentare und kollabiert Leerraum auf höchstens eine Leerzeile', () => {
		// Absatzstruktur bleibt (eine Leerzeile), die Einrückung des Mail-Templates verschwindet.
		expect(htmlZuText('<p>a   b</p><!-- weg -->\n\n\n<p>c</p>')).toBe('a b\n\nc');
	});
});

describe('Graph-Nachricht → Mail-Zeile', () => {
	it('übernimmt Ankunftszeit, Absender, Empfänger und Betreff', () => {
		const zeile = zuMailZeile(
			nachricht({
				ccRecipients: [{ emailAddress: { address: 'NOC@example.test' } }],
				body: { contentType: 'text', content: 'Alles gut.' }
			})
		);

		expect(zeile).toEqual({
			graphMessageId: 'AAMkAGVm-1',
			ankunftszeit: new Date('2026-07-27T05:40:12Z'),
			absender: 'reports@hersteller.test',
			// Klein geschrieben und dedupliziert: dieselbe Adresse in To und Cc ist ein Empfänger.
			empfaenger: ['noc@example.test'],
			betreff: 'Backup completed',
			bodyText: 'Alles gut.'
		});
	});

	it('reduziert einen HTML-Body, falls Graph die Text-Präferenz ignoriert', () => {
		const zeile = zuMailZeile(
			nachricht({ body: { contentType: 'html', content: '<p>Job A: <b>ok</b></p>' } })
		);

		expect(zeile?.bodyText).toBe('Job A: ok');
	});

	it('überspringt @removed-Einträge, statt die Ankunft zu widerrufen', () => {
		// Delta meldet Löschungen und Gelesen-Wechsel mit; dass die Mail ankam, bleibt trotzdem wahr.
		expect(zuMailZeile({ id: 'AAMkAGVm-1', '@removed': { reason: 'deleted' } })).toBeNull();
	});

	it('verwirft einen Eintrag ohne brauchbare Ankunftszeit', () => {
		expect(zuMailZeile(nachricht({ receivedDateTime: undefined }))).toBeNull();
		expect(zuMailZeile(nachricht({ receivedDateTime: 'gestern' }))).toBeNull();
	});

	it('verwirft einen Eintrag ohne Id', () => {
		expect(zuMailZeile(nachricht({ id: '  ' }))).toBeNull();
	});

	it('fällt für den Absender auf sender zurück und für den Body auf bodyPreview', () => {
		const zeile = zuMailZeile(
			nachricht({
				from: undefined,
				sender: { emailAddress: { address: 'relay@hersteller.test' } },
				body: { contentType: 'text', content: '   ' },
				bodyPreview: 'Nur die Vorschau'
			})
		);

		expect(zeile).toMatchObject({
			absender: 'relay@hersteller.test',
			bodyText: 'Nur die Vorschau'
		});
	});

	it('nimmt eine Mail ganz ohne Body und ohne Betreff an', () => {
		const zeile = zuMailZeile(nachricht({ subject: undefined }));

		expect(zeile).toMatchObject({ betreff: '', bodyText: null, empfaenger: ['noc@example.test'] });
	});
});
