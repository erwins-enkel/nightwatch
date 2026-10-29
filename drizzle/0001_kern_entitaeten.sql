CREATE TYPE "public"."alarm_ereignis" AS ENUM('alarm', 'entwarnung', 'verschaerfung');--> statement-breakpoint
CREATE TYPE "public"."alarmgrund" AS ENUM('ueberfaellig', 'fehler_gemeldet', 'unklar', 'ereignis_eingetroffen', 'paar_zu_lange_offen', 'zaehler_ueber_obergrenze', 'zaehler_unter_untergrenze');--> statement-breakpoint
CREATE TYPE "public"."erholungs_art" AS ENUM('beweis', 'erledigt', 'auto_zurueck', 'archiviert');--> statement-breakpoint
CREATE TYPE "public"."erwartung_modus" AS ENUM('intervall', 'kalenderplan');--> statement-breakpoint
CREATE TYPE "public"."klassifikation" AS ENUM('ok', 'fehler', 'unklar');--> statement-breakpoint
CREATE TYPE "public"."kunde_zustand" AS ENUM('aktiv', 'archiviert');--> statement-breakpoint
CREATE TYPE "public"."monitor_art" AS ENUM('heartbeat', 'ereignis', 'paar', 'zaehler');--> statement-breakpoint
CREATE TYPE "public"."monitor_zustand" AS ENUM('gesund', 'gestoert');--> statement-breakpoint
CREATE TYPE "public"."regel_quelle" AS ENUM('manuell', 'vorlage', 'abgeleitet');--> statement-breakpoint
CREATE TYPE "public"."selbst_monitor_art" AS ENUM('kern', 'postfach');--> statement-breakpoint
CREATE TYPE "public"."takt_klasse" AS ENUM('intervall', 'taeglich', 'werktaeglich', 'woechentlich');--> statement-breakpoint
CREATE TYPE "public"."ticket_zustand" AS ENUM('offen', 'geschlossen');--> statement-breakpoint
CREATE TYPE "public"."triage_grund" AS ENUM('kein_kunde', 'mehrdeutig', 'kein_monitor');--> statement-breakpoint
CREATE TYPE "public"."vorlagen_herkunft" AS ENUM('kuratiert', 'eigen');--> statement-breakpoint
CREATE TYPE "public"."zuordnungs_stufe" AS ENUM('plus_adresse', 'inhaltsmuster', 'absender');--> statement-breakpoint
CREATE TYPE "public"."zustell_kanal" AS ENUM('autotask', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."zustell_zustand" AS ENUM('offen', 'zugestellt', 'fehlgeschlagen');--> statement-breakpoint
CREATE TABLE "postfach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bezeichnung" text NOT NULL,
	"adresse" text NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_chiffre" text,
	"secret_ablauf_am" timestamp with time zone,
	"delta_token" text,
	"letzter_erfolgreicher_poll" timestamp with time zone,
	"letzter_fehler_code" text,
	"letzter_fehler_text" text,
	"letzter_fehler_am" timestamp with time zone,
	"poll_intervall_sekunden" integer DEFAULT 120 NOT NULL,
	"lernfenster_tage" integer DEFAULT 30 NOT NULL,
	"lernfenster_abgeschlossen_am" timestamp with time zone,
	"aktiv" boolean DEFAULT true NOT NULL,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postfach_adresse_unique" UNIQUE("adresse")
);
--> statement-breakpoint
CREATE TABLE "kunde" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kundennummer" text,
	"notiz" text,
	"zustand" "kunde_zustand" DEFAULT 'aktiv' NOT NULL,
	"archiviert_am" timestamp with time zone,
	"autotask_company_id" bigint,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kunde_archiviert_am_zum_zustand" CHECK ((zustand = 'archiviert') = (archiviert_am is not null))
);
--> statement-breakpoint
CREATE TABLE "zuordnungs_merkmal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kunde_id" uuid NOT NULL,
	"stufe" "zuordnungs_stufe" NOT NULL,
	"wert" text NOT NULL,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zuordnungs_merkmal_kunde_stufe_wert_key" UNIQUE("kunde_id","stufe","wert")
);
--> statement-breakpoint
CREATE TABLE "ausnahmekalender" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"beschreibung" text,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ausnahmekalender_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "ausnahmetag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kalender_id" uuid NOT NULL,
	"datum" date NOT NULL,
	"bezeichnung" text,
	CONSTRAINT "ausnahmetag_kalender_datum_key" UNIQUE("kalender_id","datum")
);
--> statement-breakpoint
CREATE TABLE "monitor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kunde_id" uuid NOT NULL,
	"bezeichnung" text NOT NULL,
	"art" "monitor_art" NOT NULL,
	"postfach_id" uuid,
	"erwartung_modus" "erwartung_modus",
	"erwartung_intervall_sekunden" integer,
	"erwartung_plan" jsonb,
	"karenz_sekunden" integer,
	"auto_zurueck_sekunden" integer,
	"max_offenzeit_sekunden" integer,
	"zaehler_fenster_sekunden" integer,
	"zaehler_obergrenze" integer,
	"zaehler_untergrenze" integer,
	"entwarnungs_stabilitaet_sekunden" integer,
	"zustand" "monitor_zustand" DEFAULT 'gesund' NOT NULL,
	"alarmgrund" "alarmgrund",
	"zustand_seit" timestamp with time zone DEFAULT now() NOT NULL,
	"pausiert" boolean DEFAULT false NOT NULL,
	"pausiert_bis" timestamp with time zone,
	"aktiviert_am" timestamp with time zone,
	"zuletzt_gesehen_am" timestamp with time zone,
	"paar_offen_seit" timestamp with time zone,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_parameter_je_art" CHECK (case art
				when 'heartbeat' then
					erwartung_modus is not null and karenz_sekunden is not null
					and auto_zurueck_sekunden is null and max_offenzeit_sekunden is null
					and zaehler_fenster_sekunden is null
					and zaehler_obergrenze is null and zaehler_untergrenze is null
					and paar_offen_seit is null
				when 'ereignis' then
					auto_zurueck_sekunden is not null
					and erwartung_modus is null and karenz_sekunden is null
					and max_offenzeit_sekunden is null and zaehler_fenster_sekunden is null
					and zaehler_obergrenze is null and zaehler_untergrenze is null
					and paar_offen_seit is null
				when 'paar' then
					max_offenzeit_sekunden is not null
					and erwartung_modus is null and karenz_sekunden is null
					and auto_zurueck_sekunden is null and zaehler_fenster_sekunden is null
					and zaehler_obergrenze is null and zaehler_untergrenze is null
				when 'zaehler' then
					zaehler_fenster_sekunden is not null
					and (zaehler_obergrenze is not null or zaehler_untergrenze is not null)
					and erwartung_modus is null and karenz_sekunden is null
					and auto_zurueck_sekunden is null and max_offenzeit_sekunden is null
					and paar_offen_seit is null
				else false
			end),
	CONSTRAINT "monitor_alarmgrund_zum_zustand" CHECK ((zustand = 'gestoert') = (alarmgrund is not null)),
	CONSTRAINT "monitor_erwartung_vollstaendig" CHECK (case
				when erwartung_modus is null then
					erwartung_intervall_sekunden is null and erwartung_plan is null
				when erwartung_modus = 'intervall' then
					erwartung_intervall_sekunden is not null and erwartung_plan is null
				when erwartung_modus = 'kalenderplan' then
					erwartung_plan is not null and erwartung_intervall_sekunden is null
				else false
			end),
	CONSTRAINT "monitor_parameter_plausibel" CHECK (karenz_sekunden >= 0
				and erwartung_intervall_sekunden > 0
				and auto_zurueck_sekunden > 0
				and max_offenzeit_sekunden >= 0
				and zaehler_fenster_sekunden > 0
				and zaehler_obergrenze >= 0
				and zaehler_untergrenze >= 0
				and entwarnungs_stabilitaet_sekunden >= 0
				and (
					zaehler_obergrenze is null or zaehler_untergrenze is null
					or zaehler_obergrenze >= zaehler_untergrenze
				))
);
--> statement-breakpoint
CREATE TABLE "monitor_ausnahmekalender" (
	"monitor_id" uuid NOT NULL,
	"kalender_id" uuid NOT NULL,
	CONSTRAINT "monitor_ausnahmekalender_monitor_id_kalender_id_pk" PRIMARY KEY("monitor_id","kalender_id")
);
--> statement-breakpoint
CREATE TABLE "regel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"absender" text[] DEFAULT '{}'::text[] NOT NULL,
	"betreff_muster" text[] DEFAULT '{}'::text[] NOT NULL,
	"schluesselwoerter" text[] DEFAULT '{}'::text[] NOT NULL,
	"muster_schlecht" text[] DEFAULT '{}'::text[] NOT NULL,
	"muster_gut" text[] DEFAULT '{}'::text[] NOT NULL,
	"quelle" "regel_quelle" NOT NULL,
	"vorlage_id" uuid,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	"geaendert_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regel_monitor_id_unique" UNIQUE("monitor_id")
);
--> statement-breakpoint
CREATE TABLE "regel_vorlage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schluessel" text NOT NULL,
	"name" text NOT NULL,
	"hersteller" text,
	"beschreibung" text,
	"herkunft" "vorlagen_herkunft" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"vorgeschlagene_art" "monitor_art",
	"absender" text[] DEFAULT '{}'::text[] NOT NULL,
	"betreff_muster" text[] DEFAULT '{}'::text[] NOT NULL,
	"schluesselwoerter" text[] DEFAULT '{}'::text[] NOT NULL,
	"muster_schlecht" text[] DEFAULT '{}'::text[] NOT NULL,
	"muster_gut" text[] DEFAULT '{}'::text[] NOT NULL,
	"parameter_defaults" jsonb,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regel_vorlage_schluessel_unique" UNIQUE("schluessel")
);
--> statement-breakpoint
CREATE TABLE "mail" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"postfach_id" uuid NOT NULL,
	"graph_message_id" text NOT NULL,
	"ankunftszeit" timestamp with time zone NOT NULL,
	"verarbeitet_am" timestamp with time zone,
	"absender" text NOT NULL,
	"empfaenger" text[] DEFAULT '{}'::text[] NOT NULL,
	"betreff" text NOT NULL,
	"body_text" text,
	"kunde_id" uuid,
	"monitor_id" uuid,
	"zuordnungs_merkmal_id" uuid,
	"sorte_id" uuid,
	"triage_grund" "triage_grund",
	"klassifikation" "klassifikation"
);
--> statement-breakpoint
CREATE TABLE "mail_sorte" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kunde_id" uuid NOT NULL,
	"signatur" text NOT NULL,
	"absender" text NOT NULL,
	"betreff_muster" text NOT NULL,
	"anzahl" integer DEFAULT 0 NOT NULL,
	"erster_eingang" timestamp with time zone,
	"letzter_eingang" timestamp with time zone,
	"takt_klasse" "takt_klasse",
	"takt_intervall_sekunden" integer,
	"takt_uhrzeit" text,
	"takt_wochentag" integer,
	"takt_vorkommen" integer,
	"ignoriert" boolean DEFAULT false NOT NULL,
	"ignoriert_am" timestamp with time zone,
	CONSTRAINT "mail_sorte_kunde_signatur_key" UNIQUE("kunde_id","signatur"),
	CONSTRAINT "mail_sorte_ignoriert_am_zum_flag" CHECK (ignoriert = (ignoriert_am is not null))
);
--> statement-breakpoint
CREATE TABLE "ticket_korrelation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid,
	"selbst_monitor_id" uuid,
	"uebergang_id" uuid,
	"korrelations_key" text NOT NULL,
	"ticket_id" text,
	"ticket_nummer" text,
	"zustand" "ticket_zustand" DEFAULT 'offen' NOT NULL,
	"angelegt_am" timestamp with time zone,
	"letzter_kommentar_am" timestamp with time zone,
	"geschlossen_am" timestamp with time zone,
	CONSTRAINT "ticket_korrelation_korrelations_key_unique" UNIQUE("korrelations_key"),
	CONSTRAINT "ticket_korrelation_genau_ein_monitor" CHECK ((monitor_id is not null) <> (selbst_monitor_id is not null)),
	CONSTRAINT "ticket_korrelation_geschlossen_am_zum_zustand" CHECK ((zustand = 'geschlossen') = (geschlossen_am is not null))
);
--> statement-breakpoint
CREATE TABLE "uebergang" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid,
	"selbst_monitor_id" uuid,
	"alarmgrund" "alarmgrund" NOT NULL,
	"verschaerft_am" timestamp with time zone,
	"begonnen_am" timestamp with time zone DEFAULT now() NOT NULL,
	"letztes_vorkommen_am" timestamp with time zone DEFAULT now() NOT NULL,
	"vorkommen" integer DEFAULT 1 NOT NULL,
	"beendet_am" timestamp with time zone,
	"entwarnt_am" timestamp with time zone,
	"erholungs_art" "erholungs_art",
	"quittiert_am" timestamp with time zone,
	"vorgaenger_id" uuid,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uebergang_alert_id_unique" UNIQUE("alert_id"),
	CONSTRAINT "uebergang_genau_ein_monitor" CHECK ((monitor_id is not null) <> (selbst_monitor_id is not null)),
	CONSTRAINT "uebergang_erholung_vollstaendig" CHECK ((beendet_am is null) = (erholungs_art is null)),
	CONSTRAINT "uebergang_entwarnung_nach_erholung" CHECK (entwarnt_am is null or (beendet_am is not null and entwarnt_am >= beendet_am))
);
--> statement-breakpoint
CREATE TABLE "webhook_ziel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bezeichnung" text NOT NULL,
	"url" text NOT NULL,
	"secret_chiffre" text,
	"aktiv" boolean DEFAULT true NOT NULL,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zustellung" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uebergang_id" uuid NOT NULL,
	"ereignis" "alarm_ereignis" NOT NULL,
	"kanal" "zustell_kanal" NOT NULL,
	"webhook_ziel_id" uuid,
	"job_id" text,
	"zustand" "zustell_zustand" DEFAULT 'offen' NOT NULL,
	"versuche" integer DEFAULT 0 NOT NULL,
	"letzter_fehler" text,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	"zugestellt_am" timestamp with time zone,
	CONSTRAINT "zustellung_ziel_je_kanal" CHECK ((kanal = 'webhook' and webhook_ziel_id is not null)
				or (kanal = 'autotask' and webhook_ziel_id is null))
);
--> statement-breakpoint
CREATE TABLE "einstellungen" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"retention_tage" integer DEFAULT 90 NOT NULL,
	"zeitzone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"entwarnungs_stabilitaet_sekunden" integer DEFAULT 900 NOT NULL,
	"heartbeat_ping_url_chiffre" text,
	"heartbeat_ping_intervall_sekunden" integer DEFAULT 300 NOT NULL,
	"autotask_aktiv" boolean DEFAULT false NOT NULL,
	"autotask_zone_url" text,
	"autotask_benutzer" text,
	"autotask_secret_chiffre" text,
	"autotask_integration_code_chiffre" text,
	"autotask_ticket_defaults" jsonb,
	"geaendert_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "einstellungen_singleton" CHECK (id = 1),
	CONSTRAINT "einstellungen_plausibel" CHECK (retention_tage >= 30
				and entwarnungs_stabilitaet_sekunden >= 0
				and heartbeat_ping_intervall_sekunden > 0)
);
--> statement-breakpoint
CREATE TABLE "selbst_monitor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schluessel" text NOT NULL,
	"art" "selbst_monitor_art" NOT NULL,
	"postfach_id" uuid,
	"bezeichnung" text NOT NULL,
	"zustand" "monitor_zustand" DEFAULT 'gesund' NOT NULL,
	"alarmgrund" "alarmgrund",
	"zustand_seit" timestamp with time zone DEFAULT now() NOT NULL,
	"staleness_sekunden" integer DEFAULT 900 NOT NULL,
	"entwarnungs_stabilitaet_sekunden" integer,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selbst_monitor_schluessel_unique" UNIQUE("schluessel"),
	CONSTRAINT "selbst_monitor_postfach_id_unique" UNIQUE("postfach_id"),
	CONSTRAINT "selbst_monitor_kern_ohne_postfach" CHECK (art = 'postfach' or postfach_id is null),
	CONSTRAINT "selbst_monitor_alarmgrund_zum_zustand" CHECK ((zustand = 'gestoert') = (alarmgrund is not null)),
	CONSTRAINT "selbst_monitor_parameter_plausibel" CHECK (staleness_sekunden > 0 and entwarnungs_stabilitaet_sekunden >= 0)
);
--> statement-breakpoint
ALTER TABLE "zuordnungs_merkmal" ADD CONSTRAINT "zuordnungs_merkmal_kunde_id_kunde_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunde"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ausnahmetag" ADD CONSTRAINT "ausnahmetag_kalender_id_ausnahmekalender_id_fk" FOREIGN KEY ("kalender_id") REFERENCES "public"."ausnahmekalender"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_kunde_id_kunde_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunde"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_postfach_id_postfach_id_fk" FOREIGN KEY ("postfach_id") REFERENCES "public"."postfach"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_ausnahmekalender" ADD CONSTRAINT "monitor_ausnahmekalender_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_ausnahmekalender" ADD CONSTRAINT "monitor_ausnahmekalender_kalender_id_ausnahmekalender_id_fk" FOREIGN KEY ("kalender_id") REFERENCES "public"."ausnahmekalender"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regel" ADD CONSTRAINT "regel_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regel" ADD CONSTRAINT "regel_vorlage_id_regel_vorlage_id_fk" FOREIGN KEY ("vorlage_id") REFERENCES "public"."regel_vorlage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_postfach_id_postfach_id_fk" FOREIGN KEY ("postfach_id") REFERENCES "public"."postfach"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_kunde_id_kunde_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunde"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_zuordnungs_merkmal_id_zuordnungs_merkmal_id_fk" FOREIGN KEY ("zuordnungs_merkmal_id") REFERENCES "public"."zuordnungs_merkmal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_sorte_id_mail_sorte_id_fk" FOREIGN KEY ("sorte_id") REFERENCES "public"."mail_sorte"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sorte" ADD CONSTRAINT "mail_sorte_kunde_id_kunde_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunde"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_korrelation" ADD CONSTRAINT "ticket_korrelation_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_korrelation" ADD CONSTRAINT "ticket_korrelation_selbst_monitor_id_selbst_monitor_id_fk" FOREIGN KEY ("selbst_monitor_id") REFERENCES "public"."selbst_monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_korrelation" ADD CONSTRAINT "ticket_korrelation_uebergang_id_uebergang_id_fk" FOREIGN KEY ("uebergang_id") REFERENCES "public"."uebergang"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uebergang" ADD CONSTRAINT "uebergang_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uebergang" ADD CONSTRAINT "uebergang_selbst_monitor_id_selbst_monitor_id_fk" FOREIGN KEY ("selbst_monitor_id") REFERENCES "public"."selbst_monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uebergang" ADD CONSTRAINT "uebergang_vorgaenger_fk" FOREIGN KEY ("vorgaenger_id") REFERENCES "public"."uebergang"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zustellung" ADD CONSTRAINT "zustellung_uebergang_id_uebergang_id_fk" FOREIGN KEY ("uebergang_id") REFERENCES "public"."uebergang"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zustellung" ADD CONSTRAINT "zustellung_webhook_ziel_id_webhook_ziel_id_fk" FOREIGN KEY ("webhook_ziel_id") REFERENCES "public"."webhook_ziel"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selbst_monitor" ADD CONSTRAINT "selbst_monitor_postfach_id_postfach_id_fk" FOREIGN KEY ("postfach_id") REFERENCES "public"."postfach"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "zuordnungs_merkmal_stufe_wert_idx" ON "zuordnungs_merkmal" USING btree ("stufe","wert");--> statement-breakpoint
CREATE INDEX "monitor_kunde_idx" ON "monitor" USING btree ("kunde_id");--> statement-breakpoint
CREATE INDEX "monitor_postfach_idx" ON "monitor" USING btree ("postfach_id");--> statement-breakpoint
CREATE INDEX "mail_postfach_ankunftszeit_idx" ON "mail" USING btree ("postfach_id","ankunftszeit");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_postfach_graph_message_key" ON "mail" USING btree ("postfach_id","graph_message_id");--> statement-breakpoint
CREATE INDEX "mail_monitor_ankunftszeit_idx" ON "mail" USING btree ("monitor_id","ankunftszeit");--> statement-breakpoint
CREATE INDEX "mail_ankunftszeit_idx" ON "mail" USING btree ("ankunftszeit");--> statement-breakpoint
CREATE INDEX "mail_kunde_ankunftszeit_idx" ON "mail" USING btree ("kunde_id","ankunftszeit");--> statement-breakpoint
CREATE INDEX "mail_sorte_idx" ON "mail" USING btree ("sorte_id");--> statement-breakpoint
CREATE INDEX "mail_zuordnungs_merkmal_idx" ON "mail" USING btree ("zuordnungs_merkmal_id");--> statement-breakpoint
CREATE INDEX "mail_triage_grund_idx" ON "mail" USING btree ("triage_grund") WHERE triage_grund is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_offen_je_monitor_key" ON "ticket_korrelation" USING btree ("monitor_id") WHERE zustand = 'offen';--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_offen_je_selbst_monitor_key" ON "ticket_korrelation" USING btree ("selbst_monitor_id") WHERE zustand = 'offen';--> statement-breakpoint
CREATE INDEX "ticket_korrelation_uebergang_idx" ON "ticket_korrelation" USING btree ("uebergang_id");--> statement-breakpoint
CREATE INDEX "uebergang_monitor_begonnen_idx" ON "uebergang" USING btree ("monitor_id","begonnen_am" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "uebergang_selbst_monitor_begonnen_idx" ON "uebergang" USING btree ("selbst_monitor_id","begonnen_am" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uebergang_offen_je_monitor_key" ON "uebergang" USING btree ("monitor_id") WHERE beendet_am is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uebergang_offen_je_selbst_monitor_key" ON "uebergang" USING btree ("selbst_monitor_id") WHERE beendet_am is null;--> statement-breakpoint
CREATE INDEX "zustellung_uebergang_idx" ON "zustellung" USING btree ("uebergang_id");--> statement-breakpoint
CREATE INDEX "zustellung_offen_idx" ON "zustellung" USING btree ("zustand") WHERE zustand = 'offen';--> statement-breakpoint
CREATE UNIQUE INDEX "selbst_monitor_kern_key" ON "selbst_monitor" USING btree ("art") WHERE art = 'kern';