-- A 6-character code without look-alikes (0/O, 1/I/L), short enough to type on a TV.
-- It only leads to screens that still need the organizer's approval.
CREATE FUNCTION "app"."short_code"() RETURNS text
LANGUAGE sql VOLATILE
AS $$
  SELECT string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
  FROM generate_series(1, 6)
$$;--> statement-breakpoint
CREATE TABLE "app"."judge_screens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"stadium_id" uuid NOT NULL,
	"pairing_code" text,
	"token_hash" text,
	"status" "app"."screen_status" DEFAULT 'pending' NOT NULL,
	"by_organizer" boolean DEFAULT false NOT NULL,
	"device" text NOT NULL,
	"approved_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judge_screens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "short_code" text DEFAULT app.short_code() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."judge_screens" ADD CONSTRAINT "judge_screens_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "app"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."judge_screens" ADD CONSTRAINT "judge_screens_stadium_id_stadiums_id_fk" FOREIGN KEY ("stadium_id") REFERENCES "app"."stadiums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "judge_screens_tournament_idx" ON "app"."judge_screens" USING btree ("tournament_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "judge_screens_stadium_judge_idx" ON "app"."judge_screens" USING btree ("stadium_id") WHERE "app"."judge_screens"."status" = 'approved';--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD CONSTRAINT "tournaments_short_code_unique" UNIQUE("short_code");--> statement-breakpoint
-- Same protections as 0001 for the new table.
ALTER TABLE "app"."judge_screens" ENABLE ROW LEVEL SECURITY;
