import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { webhookZiel, zustellung } from '../db/schema';
import type { Tx } from '../zuordnung/db';

/**
 * Every database statement the webhook channel needs, so the modules above it stay pure.
 *
 * One table carries the whole channel: `webhook_ziel`, a receiver with its own HMAC secret
 * (SPEC §7, §12). The delivery ledger itself belongs to the lifecycle and lives in `alarm/db.ts`.
 */

type Db = ReturnType<typeof getDb>;
type Ausfuehrer = Db | Tx;

/** A receiver as the settings page sees it — the secret never leaves the server (SPEC §12). */
export interface ZielAnsicht {
	id: string;
	bezeichnung: string;
	url: string;
	httpErlaubt: boolean;
	aktiv: boolean;
	/** Whether a secret is stored. Its value is not shown, not even masked. */
	secretGespeichert: boolean;
	erstelltAm: Date;
}

export async function listeZiele(db: Ausfuehrer = getDb()): Promise<ZielAnsicht[]> {
	return db
		.select({
			id: webhookZiel.id,
			bezeichnung: webhookZiel.bezeichnung,
			url: webhookZiel.url,
			httpErlaubt: webhookZiel.httpErlaubt,
			aktiv: webhookZiel.aktiv,
			// Whether, never what: the ciphertext must not even reach the load function (SPEC §12).
			secretGespeichert: sql<boolean>`${webhookZiel.secretChiffre} is not null`,
			erstelltAm: webhookZiel.erstelltAm
		})
		.from(webhookZiel)
		.orderBy(asc(webhookZiel.erstelltAm), asc(webhookZiel.id));
}

/**
 * The receivers an event is planned for.
 *
 * Runs inside the publishing transaction (`Alarmweg.plane`), so switching a target off and
 * publishing an event cannot interleave into a delivery nobody wanted.
 */
export async function aktiveZiele(db: Ausfuehrer = getDb()): Promise<{ id: string }[]> {
	return db
		.select({ id: webhookZiel.id })
		.from(webhookZiel)
		.where(eq(webhookZiel.aktiv, true))
		.orderBy(asc(webhookZiel.erstelltAm), asc(webhookZiel.id));
}

export interface ZielEingabe {
	bezeichnung: string;
	url: string;
	httpErlaubt: boolean;
	/** Already encrypted. On update, null leaves the stored secret untouched (SPEC §12). */
	secretChiffre: string | null;
}

export async function legeZielAn(eingabe: ZielEingabe, db: Ausfuehrer = getDb()): Promise<string> {
	const [zeile] = await db
		.insert(webhookZiel)
		.values({
			bezeichnung: eingabe.bezeichnung,
			url: eingabe.url,
			httpErlaubt: eingabe.httpErlaubt,
			secretChiffre: eingabe.secretChiffre
		})
		.returning({ id: webhookZiel.id });

	return zeile.id;
}

export async function aktualisiereZiel(
	id: string,
	eingabe: ZielEingabe,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(webhookZiel)
		.set({
			bezeichnung: eingabe.bezeichnung,
			url: eingabe.url,
			httpErlaubt: eingabe.httpErlaubt,
			// An empty secret field means "keep what is stored" — a secret is never round-tripped
			// through the browser, so the form cannot echo it back for editing.
			...(eingabe.secretChiffre === null ? {} : { secretChiffre: eingabe.secretChiffre })
		})
		.where(eq(webhookZiel.id, id));
}

export async function setzeAktiv(
	id: string,
	aktiv: boolean,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db.update(webhookZiel).set({ aktiv }).where(eq(webhookZiel.id, id));
}

/**
 * Removes a receiver — refused by the foreign key while deliveries still point at it.
 *
 * That refusal is deliberate (`zustellung.webhook_ziel_id` is `ON DELETE restrict`): the ledger is
 * the evidence that alarms failed to reach this receiver, and it is what the global self-monitor
 * reads (SPEC §8). Retiring a receiver without losing that record is `aktiv = false`.
 */
export async function entferneZiel(id: string, db: Ausfuehrer = getDb()): Promise<void> {
	await db.delete(webhookZiel).where(eq(webhookZiel.id, id));
}

export interface ZustellZiel {
	id: string;
	url: string;
	aktiv: boolean;
	secretChiffre: string | null;
}

/**
 * The receiver a delivery is addressed to.
 *
 * Read through the delivery rather than by id, so the worker cannot be told to send an event to a
 * target the publisher never planned it for: the job carries nothing but the delivery id, and the
 * ledger row is what names the receiver.
 *
 * Null when either row is gone — the receiver was deleted, or the delivery was.
 */
export async function ladeZiel(
	zustellungId: string,
	db: Ausfuehrer = getDb()
): Promise<ZustellZiel | null> {
	const [zeile] = await db
		.select({
			id: webhookZiel.id,
			url: webhookZiel.url,
			aktiv: webhookZiel.aktiv,
			secretChiffre: webhookZiel.secretChiffre
		})
		.from(zustellung)
		.innerJoin(webhookZiel, eq(webhookZiel.id, zustellung.webhookZielId))
		.where(eq(zustellung.id, zustellungId))
		.limit(1);

	return zeile ?? null;
}
