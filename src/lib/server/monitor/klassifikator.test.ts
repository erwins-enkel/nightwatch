import { afterEach, describe, expect, it } from 'vitest';
import {
	holeKlassifikator,
	musterKlassifikator,
	setzeKlassifikator,
	type Klassifikator
} from './klassifikator';
import { Heuhaufen, kompiliereRegel, type RegelMail } from './regel';

function auftrag(betreff: string, muster: { schlecht?: string[]; gut?: string[] }) {
	const mail: RegelMail = { absender: 'reports@veeam.test', betreff, bodyText: null };
	const { regel } = kompiliereRegel({
		absender: [],
		betreffMuster: [],
		schluesselwoerter: [],
		musterSchlecht: muster.schlecht ?? [],
		musterGut: muster.gut ?? []
	});

	return { mail, regel, art: 'heartbeat' as const, heuhaufen: new Heuhaufen(mail) };
}

describe('Muster-Klassifikator', () => {
	it('urteilt OK, wenn nur das Gut-Muster trifft', () => {
		expect(musterKlassifikator.beurteile(auftrag('Backup completed', { gut: ['completed'] }))).toBe(
			'ok'
		);
	});

	it('urteilt Fehler, wenn nur das Schlecht-Muster trifft', () => {
		expect(musterKlassifikator.beurteile(auftrag('Backup failed', { schlecht: ['failed'] }))).toBe(
			'fehler'
		);
	});

	/** CONTEXT „Klassifikation": Fehler hat Vorrang. */
	it('gibt dem Fehler den Vorrang, wenn beide Slots treffen', () => {
		const urteil = musterKlassifikator.beurteile(
			auftrag('Backup failed — retry completed', { schlecht: ['failed'], gut: ['completed'] })
		);
		expect(urteil).toBe('fehler');
	});

	/** „Verhindert, dass neue, unbekannte Fehlertexte still als OK durchrutschen" (CONTEXT „Unklar"). */
	it('urteilt Unklar, wenn kein Slot trifft', () => {
		const urteil = musterKlassifikator.beurteile(
			auftrag('Backup skipped', { schlecht: ['failed'], gut: ['completed'] })
		);
		expect(urteil).toBe('unklar');
	});
});

describe('Steckplatz', () => {
	afterEach(() => setzeKlassifikator(musterKlassifikator));

	it('liefert v1 muster-basiert und lässt sich austauschen', () => {
		expect(holeKlassifikator()).toBe(musterKlassifikator);

		const attrappe: Klassifikator = { name: 'attrappe', beurteile: () => 'ok' };
		setzeKlassifikator(attrappe);

		expect(holeKlassifikator()).toBe(attrappe);
		expect(holeKlassifikator().beurteile(auftrag('egal', { schlecht: ['failed'] }))).toBe('ok');
	});
});
