DROP INDEX "mail_sorte_idx";--> statement-breakpoint
ALTER TABLE "mail_sorte" ADD COLUMN "takt_streuung_sekunden" integer;--> statement-breakpoint
CREATE INDEX "mail_sorte_ankunftszeit_idx" ON "mail" USING btree ("sorte_id","ankunftszeit");