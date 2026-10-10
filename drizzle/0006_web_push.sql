CREATE TABLE "app"."push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"participant_challonge_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "notified_status" "app"."call_status";--> statement-breakpoint
ALTER TABLE "app"."push_subscriptions" ADD CONSTRAINT "push_subscriptions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "app"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_player_idx" ON "app"."push_subscriptions" USING btree ("tournament_id","participant_challonge_id");
--> statement-breakpoint
-- Same protections as 0001 for the M4 table.
ALTER TABLE "app"."push_subscriptions" ENABLE ROW LEVEL SECURITY;
