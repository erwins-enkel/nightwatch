ALTER TABLE "postfach" ADD COLUMN "runde_begonnen_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "postfach" ADD COLUMN "ingestion_stand_am" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "soll_geprueft_bis_am" timestamp with time zone;