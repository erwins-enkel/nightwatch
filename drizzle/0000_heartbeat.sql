CREATE TABLE "heartbeat" (
	"dienst" text PRIMARY KEY NOT NULL,
	"zuletzt_gesehen" timestamp with time zone NOT NULL,
	"gestartet_am" timestamp with time zone NOT NULL,
	"version" text NOT NULL,
	"pid" integer NOT NULL
);
