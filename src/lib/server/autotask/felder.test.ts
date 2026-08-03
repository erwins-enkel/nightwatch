/**
 * Das Auflösen der tenant-spezifischen IDs (SPEC §7: „nie hardcoded").
 *
 * Alles hier ist reines Parsen einer aufgezeichneten `entityInformation/fields`-Antwort — die Form,
 * die Autotask liefert, inklusive der Eigenheit, dass Picklist-Werte als Zeichenketten kommen.
 */
import { describe, expect, it } from 'vitest';
import { lesePicklist } from './felder';

const antwort = {
	fields: [
		{ name: 'title', isPickList: false },
		{
			name: 'status',
			isPickList: true,
			picklistValues: [
				{ value: '5', label: 'Complete', isActive: true, isDefaultValue: false, sortOrder: 2 },
				{ value: '1', label: 'New', isActive: true, isDefaultValue: true, sortOrder: 1 },
				{ value: '9', label: 'Alt-Status', isActive: false, isDefaultValue: false, sortOrder: 3 }
			]
		}
	]
};

describe('Picklist lesen', () => {
	it('gibt die aktiven Werte in der Reihenfolge des Tenants', () => {
		expect(lesePicklist(antwort, 'status')).toEqual([
			{ wert: 1, label: 'New', standard: true },
			{ wert: 5, label: 'Complete', standard: false }
		]);
	});

	it('lässt inaktive Werte weg', () => {
		// Autotask lehnt einen *neuen* inaktiven Wert beim Schreiben ab — angeboten würde er nur zu
		// einer Ticket-Anlage führen, die weit weg vom Formular scheitert.
		expect(lesePicklist(antwort, 'status').map((wert) => wert.wert)).not.toContain(9);
	});

	it('findet das Feld unabhängig von der Schreibweise', () => {
		expect(lesePicklist(antwort, 'Status')).toHaveLength(2);
	});

	it('gibt eine leere Liste, wo nichts zu holen ist', () => {
		expect(lesePicklist(antwort, 'priority')).toEqual([]);
		expect(lesePicklist(antwort, 'title')).toEqual([]);
		expect(lesePicklist(undefined, 'status')).toEqual([]);
		expect(lesePicklist({ fields: 'kaputt' }, 'status')).toEqual([]);
	});

	it('überspringt Zeilen ohne brauchbaren Wert und füllt ein fehlendes Label', () => {
		const roh = {
			fields: [
				{
					name: 'queueID',
					picklistValues: [
						{ value: 'keine Zahl', label: 'Unsinn', isActive: true },
						{ value: 8, isActive: true }
					]
				}
			]
		};

		expect(lesePicklist(roh, 'queueID')).toEqual([{ wert: 8, label: '8', standard: false }]);
	});
});
