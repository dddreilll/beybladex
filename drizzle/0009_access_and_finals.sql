CREATE TYPE "app"."screen_status" AS ENUM('pending', 'approved');--> statement-breakpoint
CREATE TABLE "app"."board_screens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"pairing_code" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" "app"."screen_status" DEFAULT 'pending' NOT NULL,
	"device" text NOT NULL,
	"approved_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_screens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "app"."player_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"participant_challonge_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"replaced_token_hash" text,
	"device" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "app"."sign_in_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."participants" ADD COLUMN "final_rank" integer;--> statement-breakpoint
ALTER TABLE "app"."participants" ADD COLUMN "passcode" text DEFAULT lpad(floor(random() * 10000)::int::text, 4, '0') NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."participants" ADD COLUMN "sign_in_token" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "board_limit" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."board_screens" ADD CONSTRAINT "board_screens_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "app"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."player_sessions" ADD CONSTRAINT "player_sessions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "app"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sign_in_failures" ADD CONSTRAINT "sign_in_failures_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "app"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_screens_tournament_idx" ON "app"."board_screens" USING btree ("tournament_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "player_sessions_player_idx" ON "app"."player_sessions" USING btree ("tournament_id","participant_challonge_id");--> statement-breakpoint
CREATE INDEX "sign_in_failures_bucket_idx" ON "app"."sign_in_failures" USING btree ("tournament_id","bucket","created_at");--> statement-breakpoint
-- Same protections as 0001 for the M6 tables.
ALTER TABLE "app"."board_screens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."player_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."sign_in_failures" ENABLE ROW LEVEL SECURITY;
