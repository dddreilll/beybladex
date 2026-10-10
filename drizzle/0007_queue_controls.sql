ALTER TABLE "app"."matches" ADD COLUMN "call_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "auto_on_deck" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Matches that are already called when this ships are on their first call.
UPDATE "app"."matches" SET "call_count" = 1 WHERE "call_status" IN ('called', 'playing');
