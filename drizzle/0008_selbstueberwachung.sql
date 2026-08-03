ALTER TABLE "postfach" ADD COLUMN "letzter_fehler_klasse" text;--> statement-breakpoint
ALTER TABLE "zustellung" ADD COLUMN "aufgegeben_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "einstellungen" ADD COLUMN "heartbeat_ping_zuletzt_am" timestamp with time zone;--> statement-breakpoint
-- Dead letters written before this migration carry no moment of failure, and the CHECK below would
-- refuse rows that were legal when they were written. `erstellt_am` is the closest thing the row
-- still knows; it is a lower bound, never later than the actual give-up, so the self-monitor errs
-- towards „gestört seit früher" rather than towards missing the disruption. Idempotent like every
-- other migration here — it only touches the rows the constraint would otherwise reject.
UPDATE "zustellung" SET "aufgegeben_am" = "erstellt_am"
WHERE "zustand" = 'fehlgeschlagen' AND "aufgegeben_am" IS NULL;--> statement-breakpoint
ALTER TABLE "zustellung" ADD CONSTRAINT "zustellung_abschluss_zum_zustand" CHECK ((zustand = 'zugestellt') = (zugestellt_am is not null)
				and (zustand = 'fehlgeschlagen') = (aufgegeben_am is not null));