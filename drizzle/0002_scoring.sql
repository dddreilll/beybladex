CREATE TYPE "app"."outbox_status" AS ENUM('pending', 'done', 'failed', 'conflict');--> statement-breakpoint
CREATE TABLE "app"."battles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"match_id" uuid NOT NULL,
	"op_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"side" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "battles_op_id_unique" UNIQUE("op_id")
);
--> statement-breakpoint
CREATE TABLE "app"."rule_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."sync_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "app"."outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "rule_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "winner_next_challonge_id" text;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "loser_next_challonge_id" text;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "rule_preset_key" text DEFAULT 'first-to-4' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "rule_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."battles" ADD CONSTRAINT "battles_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "app"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_outbox" ADD CONSTRAINT "sync_outbox_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "app"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_outbox" ADD CONSTRAINT "sync_outbox_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "app"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "battles_match_seq_idx" ON "app"."battles" USING btree ("match_id","seq");--> statement-breakpoint
CREATE INDEX "rule_profiles_organizer_idx" ON "app"."rule_profiles" USING btree ("organizer_id");--> statement-breakpoint
CREATE INDEX "sync_outbox_tournament_status_idx" ON "app"."sync_outbox" USING btree ("tournament_id","status");--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD CONSTRAINT "tournaments_rule_profile_id_rule_profiles_id_fk" FOREIGN KEY ("rule_profile_id") REFERENCES "app"."rule_profiles"("id") ON DELETE set null ON UPDATE no action;