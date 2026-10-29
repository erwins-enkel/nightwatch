-- Seeds for rows the application may never create or delete itself.
--
-- Both inserts are `ON CONFLICT DO NOTHING` so this migration is also safe on an instance that
-- already carries the rows (SPEC §14: migrate-on-startup must be idempotent).

-- CONTEXT „Selbst-Monitor": the global one ("Nightwatch-Kern") is not creatable, not deletable
-- and not pausable, so it has to exist from the first boot. It also carries Wurzel-Unterdrückung
-- (SPEC §8) — a disturbed core silences the per-mailbox self-monitors, which needs a row to read.
-- The per-mailbox self-monitors are created together with their Postfach, not here.
INSERT INTO "selbst_monitor" ("schluessel", "art", "bezeichnung")
VALUES ('kern', 'kern', 'Nightwatch-Kern')
ON CONFLICT ("schluessel") DO NOTHING;
--> statement-breakpoint
-- The single settings row (SPEC §10). Every default lives in the column definitions, so this
-- insert only has to bring the row into existence.
INSERT INTO "einstellungen" ("id") VALUES (1)
ON CONFLICT ("id") DO NOTHING;
