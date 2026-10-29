import { describe, expect, it } from 'vitest';
import { betreffMuster, MUSTER_MAX_LAENGE, sortenSignatur } from './sorte';

describe('Betreff-Muster', () => {
	/**
	 * Der Zweck der ganzen Datei: zwei Nächte desselben Reports müssen dasselbe Muster ergeben,
	 * sonst gruppiert die unüberwachte Mail-Sorte nichts und die Liste ist so lang wie die Triage,
	 * die sie ersetzen soll.
	 */
	it('faltet Lauf-Nummern und Zeitstempel zusammen', () => {
		const montag = betreffMuster('Backup Job 4711 completed 2026-07-27 05:40');
		const dienstag = betreffMuster('Backup Job 4712 completed 2026-07-28 05:41');

		expect(montag).toBe(dienstag);
		expect(montag).toBe('Backup Job # completed #');
	});

	it('erkennt deutsche und amerikanische Datumsformate', () => {
		expect(betreffMuster('Sicherung 27.07.2026 fehlerfrei')).toBe('Sicherung # fehlerfrei');
		expect(betreffMuster('Backup 7/27/2026 done')).toBe('Backup # done');
	});

	it('erkennt GUIDs, ohne sie in Bruchstücke zu zerlegen', () => {
		expect(betreffMuster('Task 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed')).toBe('Task # failed');
	});

	it('erkennt lange Hex-Ketten wie Job-Hashes', () => {
		expect(betreffMuster('Job a3f5c9d1e7b20418 aborted')).toBe('Job # aborted');
	});

	it('entfernt gestapelte Antwort- und Weiterleitungs-Präfixe', () => {
		expect(betreffMuster('AW: Re: Fwd: Leitung down')).toBe('Leitung down');
		expect(betreffMuster('Re[2]: Leitung down')).toBe('Leitung down');
	});

	it('lässt einen Betreff ohne variable Teile unverändert', () => {
		expect(betreffMuster('  Firmware update available  ')).toBe('Firmware update available');
	});

	it('behält die Schreibweise, weil das Muster dem Betreiber angezeigt wird', () => {
		expect(betreffMuster('Backup OK')).toBe('Backup OK');
	});

	it('deckelt die Länge, damit ein Ausreißer-Betreff kein unbegrenztes Muster erzeugt', () => {
		expect(betreffMuster('x'.repeat(500))).toHaveLength(MUSTER_MAX_LAENGE);
	});

	it('kommt mit einem leeren Betreff zurecht', () => {
		expect(betreffMuster('')).toBe('');
	});
});

describe('Sorten-Signatur', () => {
	it('ist für gleichen Absender und gleiches Muster gleich', () => {
		expect(sortenSignatur('a@b.example', 'Backup #')).toBe(
			sortenSignatur('a@b.example', 'Backup #')
		);
	});

	it('trennt nach Absender und nach Muster', () => {
		expect(sortenSignatur('a@b.example', 'Backup #')).not.toBe(
			sortenSignatur('c@b.example', 'Backup #')
		);
		expect(sortenSignatur('a@b.example', 'Backup #')).not.toBe(
			sortenSignatur('a@b.example', 'Restore #')
		);
	});

	/** Der Wert trägt einen Unique-Index — er muss unabhängig von der Eingabelänge begrenzt sein. */
	it('ist unabhängig von der Eingabelänge begrenzt', () => {
		expect(sortenSignatur('a'.repeat(400), 'b'.repeat(400))).toHaveLength(64);
	});

	/** Ohne Trennzeichen wären („ab", „c") und („a", „bc") dieselbe Sorte. */
	it('verwechselt eine Verschiebung zwischen Absender und Muster nicht', () => {
		expect(sortenSignatur('ab', 'c')).not.toBe(sortenSignatur('a', 'bc'));
	});
});
