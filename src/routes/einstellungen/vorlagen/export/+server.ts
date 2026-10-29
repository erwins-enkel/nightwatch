import { error, json } from '@sveltejs/kit';
import { alsEintrag, holeVorlage, listeVorlagen } from '$lib/server/regel/db';
import { alsDatei } from '$lib/server/regel/vorlage';
import type { RequestHandler } from './$types';

/**
 * Vorlagen als Datei — `?id=` für eine einzelne, sonst alle eigenen.
 *
 * „Alle" heißt bewusst „alle eigenen": die kuratierten kommen bei jedem Empfänger mit dem Image
 * ohnehin mit, und sie mitzuschicken hieße, sie beim Einspielen als eigene Kopien festzuschreiben,
 * die kein Release mehr aktualisiert. Eine einzelne lässt sich trotzdem exportieren — als Grundlage
 * für eine eigene Abwandlung.
 */
export const GET: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id');

	if (id) {
		const zeile = await holeVorlage(id);
		if (!zeile) error(404, 'Vorlage nicht gefunden');

		return alsAnhang(alsDatei([alsEintrag(zeile)]), `nightwatch-vorlage-${zeile.schluessel}.json`);
	}

	const eigene = (await listeVorlagen()).filter((zeile) => zeile.herkunft === 'eigen');
	return alsAnhang(alsDatei(eigene.map(alsEintrag)), 'nightwatch-vorlagen.json');
};

function alsAnhang(inhalt: unknown, dateiname: string): Response {
	return json(inhalt, {
		headers: { 'content-disposition': `attachment; filename="${dateiname}"` }
	});
}
