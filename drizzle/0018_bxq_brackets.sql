ALTER TABLE "app"."tournaments" ALTER COLUMN "state" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "play_order" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "player1_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "player2_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "winner_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "section" text;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "third_place" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "if_needed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "bye" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "winner_to" jsonb;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "loser_to" jsonb;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "reported_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."participants" ADD COLUMN "group_number" integer;--> statement-breakpoint
ALTER TABLE "app"."participants" ADD COLUMN "final_seed" integer;--> statement-breakpoint
ALTER TABLE "app"."player_sessions" ADD COLUMN "participant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."push_subscriptions" ADD COLUMN "participant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "group_count" integer;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "advance_per_group" integer;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "grand_final" text DEFAULT 'reset' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "third_place" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "round_robin_legs" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD CONSTRAINT "matches_player1_id_participants_id_fk" FOREIGN KEY ("player1_id") REFERENCES "app"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD CONSTRAINT "matches_player2_id_participants_id_fk" FOREIGN KEY ("player2_id") REFERENCES "app"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD CONSTRAINT "matches_winner_id_participants_id_fk" FOREIGN KEY ("winner_id") REFERENCES "app"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."player_sessions" ADD CONSTRAINT "player_sessions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "app"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."push_subscriptions" ADD CONSTRAINT "push_subscriptions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "app"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "matches_tournament_key_idx" ON "app"."matches" USING btree ("tournament_id","key");--> statement-breakpoint
CREATE INDEX "matches_tournament_order_idx" ON "app"."matches" USING btree ("tournament_id","play_order");--> statement-breakpoint
CREATE INDEX "participants_tournament_idx" ON "app"."participants" USING btree ("tournament_id","seed");--> statement-breakpoint
CREATE UNIQUE INDEX "player_sessions_player_idx" ON "app"."player_sessions" USING btree ("tournament_id","participant_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_player_idx" ON "app"."push_subscriptions" USING btree ("tournament_id","participant_id");