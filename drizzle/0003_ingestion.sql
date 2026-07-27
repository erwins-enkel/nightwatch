ALTER TABLE "postfach" ADD COLUMN "delta_folge_link" text;--> statement-breakpoint
ALTER TABLE "postfach" ADD COLUMN "naechster_poll_fruehestens_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "postfach" ADD COLUMN "fehler_in_folge" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail" ADD COLUMN "aus_lernfenster" boolean DEFAULT false NOT NULL;