ALTER TABLE "app"."board_screens" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."judge_screens" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."player_sessions" ADD COLUMN "closed_at" timestamp with time zone;