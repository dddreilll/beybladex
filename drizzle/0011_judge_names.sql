-- A judge's name starts as the detected device name; judges already signed up keep theirs.
ALTER TABLE "app"."judge_screens" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "app"."judge_screens" SET "name" = "device";--> statement-breakpoint
ALTER TABLE "app"."judge_screens" ALTER COLUMN "name" SET NOT NULL;
