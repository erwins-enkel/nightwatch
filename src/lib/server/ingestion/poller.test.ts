import { describe, expect, it, vi } from 'vitest';
import type { GraphAntwort, GraphPort } from '../graph/client';
import type { MailZeile } from '../graph/nachricht';
import { initialeDeltaUrl, pollePostfach, SEITEN_PRO_LAUF, type PollPostfach } from './poller';

const jetzt = new Date('2026-07-27T12:00:00Z');

const postfach = (rest: Partial<PollPostfach> = {}): PollPostfach => ({
	id: 'p1',
	adresse: 'noc@example.test',
	deltaToken: null,
	deltaFolgeLink: null,
	letzterErfolgreicherPoll: null,
	pollIntervallSekunden: 120,
	lernfensterTage: 30,
	lernfensterAbgeschlossenAm: null,
	fehlerInFolge: 0,
	erstelltAm: new Date('2026-07-27T10:00:00Z'),
	...rest
});

const nachricht = (id: string, empfangen = '2026-07-20T05:40:00Z') => ({
	id,
	receivedDateTime: empfangen,
	from: { emailAddress: { address: 'reports@hersteller.test' } },
	subject: `Report ${id}`,
	body: { contentType: 'text', content: 'ok' }
});

/** Serves the prepared responses in order and records which URLs were asked for. */
function fakeGraph(antworten: GraphAntwort[]): GraphPort & { urls: string[] } {
	const urls: string[] = [];
	let i = 0;
	return {
		urls,
		holeSeite(url: string) {
			urls.push(url);
			const antwort = antworten[i++];
			if (!antwort) throw new Error(`unerwarteter Aufruf: ${url}`);
			return Promise.resolve(antwort);
		}
	};
}

const ok = (body: unknown): GraphAntwort => ({ status: 200, body, retryAfter: null });

function laufen(optionen: {
	postfach?: PollPostfach;
	graph: GraphPort;
	gespeichert?: MailZeile[];
}) {
	const gespeichert = optionen.gespeichert ?? [];
	return pollePostfach({
		postfach: optionen.postfach ?? postfach(),
		graph: optionen.graph,
		speichere: (mails) => {
			gespeichert.push(...mails);
			return Promise.resolve(mails.length);
		},
		jetzt,
		zufall: () => 0.5
	});
}

describe('Initiale Delta-URL — das Lernfenster ist der Filter', () => {
	it('startet 30 Tage vor der Anlage des Postfachs', () => {
		const url = new URL(initialeDeltaUrl(postfach()), 'https://graph.microsoft.com/v1.0');

		// Pfad relativ zur Version — `client.api()` setzt Host und `v1.0` davor.
		expect(url.pathname).toBe('/users/noc%40example.test/mailFolders/inbox/messages/delta');
		expect(url.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-06-27T10:00:00Z');
	});

	it('folgt einem konfigurierten Lernfenster', () => {
		const url = new URL(
			initialeDeltaUrl(postfach({ lernfensterTage: 7 })),
			'https://graph.microsoft.com/v1.0'
		);

		expect(url.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-07-20T10:00:00Z');
	});

	it('lässt das $ der OData-Optionen unkodiert', () => {
		// `URLSearchParams` würde `%24filter` schreiben — das ist keine erkannte System-Query-Option
		// mehr, weder für Graph noch für den Parser des SDKs.
		const url = initialeDeltaUrl(postfach());

		expect(url).toContain('?$filter=');
		expect(url).toContain('&$select=');
		expect(url).not.toContain('%24');
	});

	it('fordert keine Anhänge an (SPEC §11)', () => {
		const url = new URL(initialeDeltaUrl(postfach()), 'https://graph.microsoft.com/v1.0');
		const felder = url.searchParams.get('$select') ?? '';

		expect(felder).not.toMatch(/attachment/i);
		expect(felder).toContain('receivedDateTime');
	});

	it('setzt nach einem Resync beim letzten erfolgreichen Poll an, nicht wieder 30 Tage zurück', () => {
		const url = new URL(
			initialeDeltaUrl(
				postfach({
					lernfensterAbgeschlossenAm: new Date('2026-07-27T10:05:00Z'),
					letzterErfolgreicherPoll: new Date('2026-07-27T11:30:00Z')
				})
			),
			'https://graph.microsoft.com/v1.0'
		);

		// Eine Stunde Überlappung, damit an der Nahtstelle keine Mail verloren geht.
		expect(url.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-07-27T10:30:00Z');
	});
});

describe('Delta-Runde', () => {
	it('schließt eine einseitige Runde ab und meldet das Lernfenster als fertig', async () => {
		const graph = fakeGraph([
			ok({ value: [nachricht('m1'), nachricht('m2')], '@odata.deltaLink': 'https://…/delta?$dt=A' })
		]);
		const gespeichert: MailZeile[] = [];

		const ergebnis = await laufen({ graph, gespeichert });

		expect(ergebnis).toEqual({
			art: 'erfolg',
			mails: 2,
			deltaFolgeLink: null,
			deltaToken: 'https://…/delta?$dt=A',
			rundeAbgeschlossen: true,
			lernfensterAbgeschlossen: true
		});
		expect(gespeichert.map((m) => m.graphMessageId)).toEqual(['m1', 'm2']);
	});

	it('folgt nextLink innerhalb eines Laufs und merkt sich den vollständigen Link', async () => {
		const graph = fakeGraph([
			ok({ value: [nachricht('m1')], '@odata.nextLink': 'https://graph/next-1' }),
			ok({ value: [nachricht('m2')], '@odata.deltaLink': 'https://graph/delta-final' })
		]);

		const ergebnis = await laufen({ graph });

		expect(graph.urls[1]).toBe('https://graph/next-1');
		expect(ergebnis).toMatchObject({ mails: 2, deltaToken: 'https://graph/delta-final' });
	});

	it('bricht nach dem Seiten-Budget ab und hebt den nextLink für den nächsten Tick auf', async () => {
		// Sonst blockierte ein 30-Tage-Backfill eines vollen Postfachs alle anderen Postfächer.
		const graph = fakeGraph(
			Array.from({ length: SEITEN_PRO_LAUF }, (_, i) =>
				ok({ value: [nachricht(`m${i}`)], '@odata.nextLink': `https://graph/next-${i + 1}` })
			)
		);

		const ergebnis = await laufen({ graph });

		expect(graph.urls).toHaveLength(SEITEN_PRO_LAUF);
		expect(ergebnis).toMatchObject({
			art: 'erfolg',
			mails: SEITEN_PRO_LAUF,
			deltaFolgeLink: `https://graph/next-${SEITEN_PRO_LAUF}`,
			deltaToken: null,
			// Die Runde läuft noch — das Lernfenster ist erst mit dem deltaLink durch.
			rundeAbgeschlossen: false,
			lernfensterAbgeschlossen: false
		});
	});

	/**
	 * Der Fall, wegen dem `rundeAbgeschlossen` ein eigenes Feld ist (#26): ohne deltaLink *und* ohne
	 * nextLink endet der Lauf mit denselben Link-Feldern wie eine abgeschlossene Runde — er trägt den
	 * alten Token weiter. Aus den Links allein wäre Vollständigkeit hier nicht unterscheidbar, und
	 * `ingestion_stand_am` darf sie nur behaupten, wo sie belegt ist.
	 */
	it('meldet eine Runde ohne deltaLink nicht als abgeschlossen', async () => {
		const graph = fakeGraph([ok({ value: [nachricht('m1')] })]);

		const ergebnis = await laufen({
			postfach: postfach({ deltaToken: 'https://graph/delta-alt' }),
			graph
		});

		expect(ergebnis).toMatchObject({
			art: 'erfolg',
			deltaFolgeLink: null,
			deltaToken: 'https://graph/delta-alt',
			rundeAbgeschlossen: false
		});
	});

	it('setzt eine unterbrochene Runde beim gespeicherten nextLink fort', async () => {
		const graph = fakeGraph([ok({ value: [], '@odata.deltaLink': 'https://graph/delta-final' })]);

		const ergebnis = await laufen({
			postfach: postfach({ deltaFolgeLink: 'https://graph/next-7' }),
			graph
		});

		expect(graph.urls).toEqual(['https://graph/next-7']);
		expect(ergebnis).toMatchObject({ deltaToken: 'https://graph/delta-final' });
	});

	it('schließt das Lernfenster auch ab, wenn der Backfill mehrere Ticks brauchte', async () => {
		// Der Abschluss hängt am Zustand des Postfachs, nicht daran, ob *dieser* Lauf die Runde
		// begonnen hat. Sonst bliebe jeder Backfill, der länger als ein Seiten-Budget dauert, für
		// immer als „läuft noch" stehen — und ein späterer Resync liefe wieder 30 Tage zurück.
		const graph = fakeGraph([ok({ value: [], '@odata.deltaLink': 'https://graph/delta-final' })]);

		const ergebnis = await laufen({
			postfach: postfach({
				deltaFolgeLink: 'https://graph/next-42',
				lernfensterAbgeschlossenAm: null
			}),
			graph
		});

		expect(ergebnis).toMatchObject({ lernfensterAbgeschlossen: true });
	});

	it('pollt mit dem gespeicherten deltaLink weiter, statt eine neue Runde zu beginnen', async () => {
		const graph = fakeGraph([ok({ value: [], '@odata.deltaLink': 'https://graph/delta-2' })]);

		const ergebnis = await laufen({
			postfach: postfach({
				deltaToken: 'https://graph/delta-1',
				lernfensterAbgeschlossenAm: new Date('2026-07-27T10:05:00Z')
			}),
			graph
		});

		expect(graph.urls).toEqual(['https://graph/delta-1']);
		// Die Folgerunde darf das Lernfenster nicht ein zweites Mal als „gerade fertig" melden.
		expect(ergebnis).toMatchObject({ lernfensterAbgeschlossen: false, mails: 0 });
	});

	it('überspringt @removed-Einträge, zählt aber die echten Mails', async () => {
		const graph = fakeGraph([
			ok({
				value: [nachricht('m1'), { id: 'm2', '@removed': { reason: 'deleted' } }],
				'@odata.deltaLink': 'https://graph/delta'
			})
		]);
		const gespeichert: MailZeile[] = [];

		const ergebnis = await laufen({ graph, gespeichert });

		expect(gespeichert.map((m) => m.graphMessageId)).toEqual(['m1']);
		expect(ergebnis).toMatchObject({ mails: 1 });
	});

	it('meldet null Mails, wenn eine Seite nur unbrauchbare Einträge enthält', async () => {
		const speichere = vi.fn();
		const graph = fakeGraph([
			ok({ value: [{ id: 'm1', '@removed': {} }], '@odata.deltaLink': 'https://graph/delta' })
		]);

		const ergebnis = await pollePostfach({
			postfach: postfach(),
			graph,
			speichere,
			jetzt,
			zufall: () => 0.5
		});

		expect(speichere).not.toHaveBeenCalled();
		expect(ergebnis).toMatchObject({ mails: 0 });
	});
});

describe('Fehlerpfade', () => {
	it('wartet bei 429 genau so lange wie Retry-After sagt', async () => {
		const graph = fakeGraph([
			{ status: 429, body: { error: { code: 'activityLimitReached' } }, retryAfter: '90' }
		]);

		const ergebnis = await laufen({ graph });

		expect(ergebnis).toMatchObject({
			art: 'fehler',
			wartenMs: 90_000,
			deltaZuruecksetzen: false,
			fehler: { klasse: 'throttling', code: '429' }
		});
	});

	it('verwirft bei 410 den Delta-Zustand', async () => {
		const graph = fakeGraph([
			{ status: 410, body: { error: { code: 'resyncRequired' } }, retryAfter: null }
		]);

		const ergebnis = await laufen({
			postfach: postfach({ deltaToken: 'https://graph/delta-alt' }),
			graph
		});

		expect(ergebnis).toMatchObject({ art: 'fehler', deltaZuruecksetzen: true });
	});

	it('behält bei 403 den Delta-Zustand — das Problem ist der Zugriff, nicht der Stand', async () => {
		const graph = fakeGraph([
			{ status: 403, body: { error: { code: 'ErrorAccessDenied' } }, retryAfter: null }
		]);

		const ergebnis = await laufen({ graph });

		expect(ergebnis).toMatchObject({
			art: 'fehler',
			deltaZuruecksetzen: false,
			fehler: { klasse: 'zugriff', code: 'ErrorAccessDenied' }
		});
	});

	it('behandelt einen fehlgeschlagenen Token-Abruf als Zugriffsproblem', async () => {
		const graph: GraphPort = {
			holeSeite: () => Promise.reject(new Error('AADSTS7000215: Invalid client secret provided.'))
		};

		const ergebnis = await laufen({ graph });

		expect(ergebnis).toMatchObject({ art: 'fehler', fehler: { code: 'AADSTS7000215' } });
	});

	it('behält bereits geschriebene Mails, wenn eine spätere Seite scheitert', async () => {
		// Der Fortschritt einer halb gelaufenen Runde darf nicht verloren gehen.
		const graph = fakeGraph([
			ok({ value: [nachricht('m1')], '@odata.nextLink': 'https://graph/next-1' }),
			{ status: 503, body: undefined, retryAfter: null }
		]);
		const gespeichert: MailZeile[] = [];

		const ergebnis = await laufen({ graph, gespeichert });

		expect(gespeichert).toHaveLength(1);
		expect(ergebnis).toMatchObject({ art: 'fehler', fehler: { klasse: 'throttling' } });
	});

	it('steigert den Backoff mit der Zahl der Fehler in Folge', async () => {
		const graph = fakeGraph([{ status: 500, body: undefined, retryAfter: null }]);

		const ergebnis = await laufen({ postfach: postfach({ fehlerInFolge: 2 }), graph });

		// Dritter Fehler in Folge: 120 s · 2² = 480 s, ohne Streuung.
		expect(ergebnis).toMatchObject({ art: 'fehler', wartenMs: 480_000 });
	});
});
