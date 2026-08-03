ALTER TABLE "uebergang" ADD COLUMN "alarmiert_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uebergang" ADD COLUMN "verschaerfung_gemeldet_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uebergang" ADD COLUMN "entwarnung_entfaellt_am" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "uebergang_vorgaenger_idx" ON "uebergang" USING btree ("vorgaenger_id");--> statement-breakpoint
CREATE INDEX "uebergang_veroeffentlichung_offen_idx" ON "uebergang" USING btree ("begonnen_am","id") WHERE alarmiert_am is null
				or (verschaerft_am is not null and verschaerfung_gemeldet_am is null)
				or (
					beendet_am is not null and entwarnt_am is null
					and entwarnung_entfaellt_am is null and erholungs_art <> 'archiviert'
				);--> statement-breakpoint
ALTER TABLE "uebergang" ADD CONSTRAINT "uebergang_verschaerfung_gemeldet_nach_verschaerfung" CHECK (verschaerfung_gemeldet_am is null or verschaerft_am is not null);--> statement-breakpoint
ALTER TABLE "uebergang" ADD CONSTRAINT "uebergang_entwarnung_ausgang_eindeutig" CHECK ((entwarnt_am is null or entwarnung_entfaellt_am is null)
				and (entwarnung_entfaellt_am is null or beendet_am is not null));--> statement-breakpoint
-- Episodes that already existed are declared "published". The three columns above are the
-- publisher's outbox markers (#27); left null, the first tick after an upgrade would flood
-- Autotask and every webhook with the instance's complete alarm history.
--
-- Idempotent like every other migration here: it only touches rows that carry no marker yet, so
-- re-running it can never overwrite a real publication timestamp.
UPDATE "uebergang" SET "alarmiert_am" = "begonnen_am" WHERE "alarmiert_am" IS NULL;--> statement-breakpoint
UPDATE "uebergang" SET "verschaerfung_gemeldet_am" = "verschaerft_am"
	WHERE "verschaerft_am" IS NOT NULL AND "verschaerfung_gemeldet_am" IS NULL;--> statement-breakpoint
UPDATE "uebergang" SET "entwarnt_am" = "beendet_am"
	WHERE "beendet_am" IS NOT NULL AND "entwarnt_am" IS NULL AND "erholungs_art" <> 'archiviert';