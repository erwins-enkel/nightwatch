/**
 * Die Signatur — und der Vektor, den `docs/webhook.md` wörtlich zitiert.
 *
 * Der Fall unten baut den Körper über denselben Weg wie der Ablauf (`baueEreignis` → `koerper`)
 * und friert Bytes **und** Signatur ein. Damit ist das Beispiel in der Doku nachprüfbar statt bloß
 * plausibel: ändert jemand die Feldreihenfolge oder einen Namen, fällt hier der Test und nicht
 * erst der Empfänger.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { baueEreignis, type EpisodenSicht } from '../alarm/ereignis';
import { koerper } from './nutzlast';
import { signiere } from './signatur';

const SECRET = 'ein-geheimnis';
const BASIS = 'https://nightwatch.example';
const MONITOR_ID = '9b1c7f3a-2d54-4e88-b6c1-7a0d9e5f4321';

/** Der Vektor der Doku, Zeichen für Zeichen. */
const BEISPIEL_KOERPER =
	'{"ereignis":"alarm","alert_id":"1e6f8a2c-0b7d-4d1e-9a3f-5c2b8e7d4a10",' +
	'"vorgaenger_alert_id":null,"gesendet_am":"2026-07-28T06:11:00.000Z","weisung":"eroeffnen",' +
	`"monitor":{"art":"heartbeat","id":"${MONITOR_ID}","bezeichnung":"Veeam Nachtlauf"},` +
	'"kunde":{"id":"4f2a6d90-8c31-4b77-9e05-1d6a3c8b2f45","name":"Muster GmbH"},' +
	'"alarmgrund":"ueberfaellig","erholungs_art":null,' +
	'"vorkommen":{"anzahl":1,"erste_am":"2026-07-28T06:10:00.000Z",' +
	'"letzte_am":"2026-07-28T06:10:00.000Z","verschaerft_am":null,' +
	'"stoerungsdauer_sekunden":null},' +
	`"rueckverweis":"${BASIS}/monitore/${MONITOR_ID}"}`;

const BEISPIEL_SIGNATUR = 'sha256=41bc1efeac6c1439378bf9840ab3d22bb2e1dc0d4ce4bbc0e508180e5ecd464d';

const beispiel: EpisodenSicht = {
	alertId: '1e6f8a2c-0b7d-4d1e-9a3f-5c2b8e7d4a10',
	vorgaengerAlertId: null,
	alarmgrund: 'ueberfaellig',
	begonnenAm: new Date('2026-07-28T06:10:00Z'),
	letztesVorkommenAm: new Date('2026-07-28T06:10:00Z'),
	vorkommen: 1,
	verschaerftAm: null,
	beendetAm: null,
	erholungsArt: null,
	monitor: { art: 'heartbeat', id: MONITOR_ID, bezeichnung: 'Veeam Nachtlauf' },
	kunde: { id: '4f2a6d90-8c31-4b77-9e05-1d6a3c8b2f45', name: 'Muster GmbH' }
};

describe('Signatur', () => {
	it('erzeugt den Beispiel-Körper der Doku Zeichen für Zeichen', () => {
		const gebaut = koerper(
			baueEreignis(beispiel, 'alarm', BASIS),
			new Date('2026-07-28T06:11:00Z')
		);

		expect(gebaut).toBe(BEISPIEL_KOERPER);
	});

	it('erzeugt die Beispiel-Signatur der Doku', () => {
		expect(signiere(SECRET, BEISPIEL_KOERPER)).toBe(BEISPIEL_SIGNATUR);
	});

	/** Genau die Rechnung, die `docs/webhook.md` dem Empfänger vorschlägt. */
	it('stimmt mit der Nachrechnung eines Empfängers überein', () => {
		const nachgerechnet = createHmac('sha256', SECRET).update(BEISPIEL_KOERPER, 'utf8');

		expect(signiere(SECRET, BEISPIEL_KOERPER)).toBe(`sha256=${nachgerechnet.digest('hex')}`);
	});

	it('hängt an Secret und Körper — beides zählt', () => {
		expect(signiere('anderes-geheimnis', BEISPIEL_KOERPER)).not.toBe(BEISPIEL_SIGNATUR);
		expect(signiere(SECRET, `${BEISPIEL_KOERPER} `)).not.toBe(BEISPIEL_SIGNATUR);
	});

	/** Ein Präfix, damit ein zweites Verfahren später unterscheidbar wäre. */
	it('nennt das Verfahren im Wert', () => {
		expect(signiere(SECRET, '{}')).toMatch(/^sha256=[0-9a-f]{64}$/);
	});
});
