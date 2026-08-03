ALTER TABLE "webhook_ziel" ADD COLUMN "http_erlaubt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing plain-HTTP receivers keep working: the column defaults to false, so without this the
-- CHECK below would refuse rows that were legal when they were written. Idempotent like every
-- other migration here — it only touches rows the constraint would otherwise reject.
--
-- Deliberately limited to `http://`. A row carrying any other scheme is not a receiver this
-- instance ever created, and opting it in silently would be the opposite of what the CHECK is for.
UPDATE "webhook_ziel" SET "http_erlaubt" = true WHERE "url" LIKE 'http://%';--> statement-breakpoint
ALTER TABLE "webhook_ziel" ADD CONSTRAINT "webhook_ziel_transport" CHECK ("webhook_ziel"."url" like 'https://%' or ("webhook_ziel"."http_erlaubt" and "webhook_ziel"."url" like 'http://%'));
