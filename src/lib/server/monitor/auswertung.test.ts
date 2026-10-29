import { describe, expect, it } from 'vitest';
import { monitorArt } from '../db/schema/enums';
import { deuteMail, nutztMusterSlots, type MonitorSicht } from './auswertung';

function sicht(teile: Partial<MonitorSicht> & Pick<MonitorSicht, 'art'>): MonitorSicht {
	return {
		maxOffenzeitSekunden: null,
		zaehlerObergrenze: null,
		paarOffen: false,
		...teile
	};
}

describe('Heartbeat', () => {
	const heartbeat = sicht({ art: 'heartbeat' });

	it('stört bei Fehler und erholt bei OK', () => {
		expect(deuteMail(heartbeat, 'fehler')).toMatchObject({
			klassifikation: 'fehler',
			wirkung: { art: 'stoerung', grund: 'fehler_gemeldet' }
		});
		expect(deuteMail(heartbeat, 'ok')).toMatchObject({
			klassifikation: 'ok',
			wirkung: { art: 'erholung' }
		});
	});

	/** CONTEXT „Unklar": eskaliert wie ein Fehler, aber mit eigenem Alarmgrund. */
	it('eskaliert Unklar mit eigenem Alarmgrund', () => {
		expect(deuteMail(heartbeat, 'unklar')).toMatchObject({
			klassifikation: 'unklar',
			wirkung: { art: 'stoerung', grund: 'unklar' }
		});
	});
});

describe('Ereignis', () => {
	const ereignis = sicht({ art: 'ereignis' });

	/** „Die Ankunft selbst ist das Ereignis, ein Fehler-Muster braucht diese Art nicht." */
	it('stört bei jeder nicht-harmlosen Mail', () => {
		for (const urteil of ['unklar', 'fehler'] as const) {
			expect(deuteMail(ereignis, urteil)).toMatchObject({
				klassifikation: 'fehler',
				wirkung: { art: 'stoerung', grund: 'ereignis_eingetroffen' }
			});
		}
	});

	/** „Eine harmlose Mail löst nicht aus, erholt aber auch nicht" (CONTEXT „Harmlos-Filter"). */
	it('lässt eine harmlose Mail folgenlos', () => {
		expect(deuteMail(ereignis, 'ok')).toEqual({
			klassifikation: 'ok',
			wirkung: { art: 'keine' },
			paar: null
		});
	});
});

describe('Paar', () => {
	it('alarmiert bei Auf sofort, wenn die Offenzeit 0 ist', () => {
		const wirkung = deuteMail(sicht({ art: 'paar', maxOffenzeitSekunden: 0 }), 'fehler');
		expect(wirkung).toMatchObject({
			paar: 'oeffnen',
			wirkung: { art: 'stoerung', grund: 'paar_zu_lange_offen' }
		});
	});

	it('öffnet bei längerer Offenzeit nur den Zustand', () => {
		const wirkung = deuteMail(sicht({ art: 'paar', maxOffenzeitSekunden: 900 }), 'fehler');
		expect(wirkung).toMatchObject({ paar: 'oeffnen', wirkung: { art: 'keine' } });
	});

	it('erholt beweisbasiert, wenn ein Zustand offen ist', () => {
		const wirkung = deuteMail(
			sicht({ art: 'paar', maxOffenzeitSekunden: 0, paarOffen: true }),
			'ok'
		);
		expect(wirkung).toMatchObject({ paar: 'schliessen', wirkung: { art: 'erholung' } });
	});

	/** CONTEXT „Paar-Monitor": kein Alarm, kein Unklar, nur „zuletzt gesehen". */
	it('lässt eine Zu-Mail ohne offenen Zustand neutral', () => {
		const wirkung = deuteMail(sicht({ art: 'paar', maxOffenzeitSekunden: 0 }), 'ok');
		expect(wirkung).toMatchObject({ klassifikation: 'ok', wirkung: { art: 'keine' } });
	});

	it('eskaliert eine Mail, die keinen Slot trifft', () => {
		const wirkung = deuteMail(sicht({ art: 'paar', maxOffenzeitSekunden: 0 }), 'unklar');
		expect(wirkung).toMatchObject({
			klassifikation: 'unklar',
			wirkung: { art: 'stoerung', grund: 'unklar' },
			paar: null
		});
	});
});

describe('Zähler', () => {
	const zaehler = sicht({ art: 'zaehler', zaehlerObergrenze: 50 });

	it('feuert mit der Mail, die die Obergrenze reißt', () => {
		expect(deuteMail(zaehler, null, 50).wirkung).toEqual({ art: 'keine' });
		expect(deuteMail(zaehler, null, 51).wirkung).toEqual({
			art: 'stoerung',
			grund: 'zaehler_ueber_obergrenze'
		});
	});

	it('bleibt ruhig, wenn nur eine Untergrenze gesetzt ist', () => {
		expect(deuteMail(sicht({ art: 'zaehler' }), null, 9_999).wirkung).toEqual({ art: 'keine' });
	});

	/** „Die Muster-Slots sind bei dieser Art ungenutzt" (CONTEXT „Zähl-Monitor"). */
	it('klassifiziert nicht und fragt den Klassifikator nicht', () => {
		expect(deuteMail(zaehler, null, 1).klassifikation).toBeNull();
		expect(nutztMusterSlots('zaehler')).toBe(false);
		for (const art of monitorArt.enumValues.filter((wert) => wert !== 'zaehler')) {
			expect(nutztMusterSlots(art)).toBe(true);
		}
	});
});
