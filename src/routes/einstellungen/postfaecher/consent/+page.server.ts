import type { PageServerLoad } from './$types';

/**
 * Landing page of the admin-consent redirect (SPEC §3).
 *
 * Entra ID requires `redirect_uri` on the consent endpoint and matches it against the app
 * registration character for character, so the link Nightwatch shows needs a real page behind it.
 * It is purely informational: the client-credentials flow acquires its tokens on its own, and
 * nothing here grants or stores anything.
 */
export const load: PageServerLoad = ({ url }) => {
	// Docs warning, worth heeding: never treat the returned `tenant` as authentication — anyone can
	// craft this URL. It is only read to tell the operator which grant they just came back from.
	return {
		erteilt: url.searchParams.get('admin_consent') === 'True' && !url.searchParams.has('error'),
		fehler: url.searchParams.get('error')
	};
};
