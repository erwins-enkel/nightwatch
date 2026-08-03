import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Secrets at rest (SPEC §12): AES-256-GCM with a 32-byte key from `NIGHTWATCH_SECRET_KEY`.
 *
 * Every `*_chiffre` column in the data model goes through here. #23 needs it for the Graph client
 * secret; #35 reuses it for the Autotask credentials, the webhook HMAC secrets and the
 * heartbeat-ping URL — the algorithm is fixed by the SPEC, so there is one implementation of it.
 *
 * GCM rather than CBC because it authenticates: a tampered ciphertext fails to decrypt instead of
 * yielding plausible garbage that would then be sent to Entra ID as a credential.
 *
 * Key loss is deliberately survivable — SPEC §12: "Schlüsselverlust ⇒ Credentials neu eingeben,
 * keine Datenverlust-Kaskade". Nothing but credentials is encrypted.
 */

/** 96 bit is the GCM-recommended nonce length; longer nonces are hashed and gain nothing. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Lets a future key rotation (#35) tell formats apart instead of guessing. */
const PREFIX = 'v1';

/**
 * Read on use rather than at import, like `requireDatabaseUrl()`: SvelteKit's post-build analyse
 * step imports every server module, and neither a build nor a stack that has no mailbox configured
 * yet may require a key to exist.
 */
export function requireSecretKey(): Buffer {
	const raw = process.env.NIGHTWATCH_SECRET_KEY?.trim();
	if (!raw) {
		throw new Error(
			'NIGHTWATCH_SECRET_KEY is not set — generate one with `openssl rand -base64 32` and put it in .env'
		);
	}

	// Accept base64 (what `openssl rand -base64 32` prints) as well as hex, so nobody has to
	// remember which encoding the setup instructions used.
	const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
	if (key.length !== KEY_BYTES) {
		throw new Error(
			`NIGHTWATCH_SECRET_KEY must decode to ${KEY_BYTES} bytes, got ${key.length} — generate one with \`openssl rand -base64 32\``
		);
	}
	return key;
}

/** `v1.{iv}.{tag}.{ciphertext}`, all base64 — self-describing, so no length arithmetic on read. */
export function verschluessele(klartext: string, key: Buffer = requireSecretKey()): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const chiffre = Buffer.concat([cipher.update(klartext, 'utf8'), cipher.final()]);
	return [
		PREFIX,
		iv.toString('base64'),
		cipher.getAuthTag().toString('base64'),
		chiffre.toString('base64')
	].join('.');
}

/** Throws on a wrong key, a truncated value or any tampering — never returns partial plaintext. */
export function entschluessele(gespeichert: string, key: Buffer = requireSecretKey()): string {
	const teile = gespeichert.split('.');
	if (teile.length !== 4 || teile[0] !== PREFIX) {
		throw new Error('Chiffre hat kein bekanntes Format');
	}

	const iv = Buffer.from(teile[1], 'base64');
	const tag = Buffer.from(teile[2], 'base64');
	if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
		throw new Error('Chiffre hat kein bekanntes Format');
	}

	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([
		decipher.update(Buffer.from(teile[3], 'base64')),
		decipher.final()
	]).toString('utf8');
}

/**
 * What the UI is allowed to show of a stored secret (SPEC §12: "nur Fingerprints/letzte vier
 * Zeichen"). Short secrets are masked entirely rather than half-revealed.
 */
export function secretHinweis(klartext: string): string {
	return klartext.length <= 8 ? '••••' : `••••${klartext.slice(-4)}`;
}
