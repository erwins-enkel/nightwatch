import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Domain enums. Every value is a term from CONTEXT.md, transliterated for SQL identifiers
 * (`zaehler`, `gestoert`, `ueberfaellig`) — the glossary is the source of truth, this file only
 * spells it.
 *
 * CONTEXT calls the set of monitor kinds "offen, erweiterbar". A Postgres enum still fits: a new
 * kind arrives as `ALTER TYPE ... ADD VALUE` in a migration, which is additive and forward
 * compatible (SPEC §14). Removing or renaming a value is the expensive direction, so the values
 * below are taken verbatim from the glossary rather than invented.
 *
 * Each enum exports its TypeScript union next to it; `enumValues` is also available at runtime
 * (e.g. to build UI filters) so no value list is ever written down twice.
 */

/** CONTEXT „Monitor-Art" — the v1 set. */
export const monitorArt = pgEnum('monitor_art', ['heartbeat', 'ereignis', 'paar', 'zaehler']);
export type MonitorArt = (typeof monitorArt.enumValues)[number];

/** CONTEXT „Zustandsmaschine" — there are exactly two core states; `pausiert` is an overlay. */
export const monitorZustand = pgEnum('monitor_zustand', ['gesund', 'gestoert']);
export type MonitorZustand = (typeof monitorZustand.enumValues)[number];

/** CONTEXT „Alarmgrund". */
export const alarmgrund = pgEnum('alarmgrund', [
	'ueberfaellig',
	'fehler_gemeldet',
	'unklar',
	'ereignis_eingetroffen',
	'paar_zu_lange_offen',
	'zaehler_ueber_obergrenze',
	'zaehler_unter_untergrenze'
]);
export type Alarmgrund = (typeof alarmgrund.enumValues)[number];

/** CONTEXT „Klassifikation" — three-valued, `fehler` wins over `ok`. */
export const klassifikation = pgEnum('klassifikation', ['ok', 'fehler', 'unklar']);
export type Klassifikation = (typeof klassifikation.enumValues)[number];

/**
 * CONTEXT „System-Triage" / „Unzugeordnet". `kein_monitor` is deliberately not shown as a single
 * triage entry — it is grouped into `mail_sorte` — but the mail still carries the reason.
 */
export const triageGrund = pgEnum('triage_grund', ['kein_kunde', 'mehrdeutig', 'kein_monitor']);
export type TriageGrund = (typeof triageGrund.enumValues)[number];

/** CONTEXT „Erwartung" — the two shapes a heartbeat expectation can take. */
export const erwartungModus = pgEnum('erwartung_modus', ['intervall', 'kalenderplan']);
export type ErwartungModus = (typeof erwartungModus.enumValues)[number];

/**
 * CONTEXT „Zuordnungs-Merkmal" — the fixed global priority ①②③. The declaration order is the
 * match order; first match wins, no scoring.
 */
export const zuordnungsStufe = pgEnum('zuordnungs_stufe', [
	'plus_adresse',
	'inhaltsmuster',
	'absender'
]);
export type ZuordnungsStufe = (typeof zuordnungsStufe.enumValues)[number];

/** CONTEXT „Archiviert (Kunde)". */
export const kundeZustand = pgEnum('kunde_zustand', ['aktiv', 'archiviert']);
export type KundeZustand = (typeof kundeZustand.enumValues)[number];

/** CONTEXT „Regel-Quelle" — the three prefill grades, not three separate creation paths. */
export const regelQuelle = pgEnum('regel_quelle', ['manuell', 'vorlage', 'abgeleitet']);
export type RegelQuelle = (typeof regelQuelle.enumValues)[number];

/** CONTEXT „Regel-Vorlage" — shipped in the image vs. built by the operator. */
export const vorlagenHerkunft = pgEnum('vorlagen_herkunft', ['kuratiert', 'eigen']);
export type VorlagenHerkunft = (typeof vorlagenHerkunft.enumValues)[number];

/** CONTEXT „Takt" — monthly is deliberately absent, the learning window cannot evidence it. */
export const taktKlasse = pgEnum('takt_klasse', [
	'intervall',
	'taeglich',
	'werktaeglich',
	'woechentlich'
]);
export type TaktKlasse = (typeof taktKlasse.enumValues)[number];

/**
 * CONTEXT „Beweisbasierte Erholung" — only `beweis` may close a ticket automatically; the others
 * comment and leave the ticket open. `archiviert` is the silent end of a disruption when its
 * customer is archived (CONTEXT „Archiviert (Kunde)": no all-clear is sent).
 */
export const erholungsArt = pgEnum('erholungs_art', [
	'beweis',
	'erledigt',
	'auto_zurueck',
	'archiviert'
]);
export type ErholungsArt = (typeof erholungsArt.enumValues)[number];

/** CONTEXT „Selbst-Monitor" — one global core monitor plus one per mailbox. */
export const selbstMonitorArt = pgEnum('selbst_monitor_art', ['kern', 'postfach']);
export type SelbstMonitorArt = (typeof selbstMonitorArt.enumValues)[number];

/** SPEC §7 — the webhook event names, also used to label a delivery. */
export const alarmEreignis = pgEnum('alarm_ereignis', ['alarm', 'entwarnung', 'verschaerfung']);
export type AlarmEreignis = (typeof alarmEreignis.enumValues)[number];

/** SPEC §7 — the alarm channels that need durable delivery. The dashboard is always on. */
export const zustellKanal = pgEnum('zustell_kanal', ['autotask', 'webhook']);
export type ZustellKanal = (typeof zustellKanal.enumValues)[number];

/** SPEC §7 — `fehlgeschlagen` is the dead-letter state after the retries are exhausted. */
export const zustellZustand = pgEnum('zustell_zustand', ['offen', 'zugestellt', 'fehlgeschlagen']);
export type ZustellZustand = (typeof zustellZustand.enumValues)[number];

/** SPEC §10 — the lifecycle of a correlated PSA ticket, as far as Nightwatch tracks it. */
export const ticketZustand = pgEnum('ticket_zustand', ['offen', 'geschlossen']);
export type TicketZustand = (typeof ticketZustand.enumValues)[number];
