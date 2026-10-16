ALTER TABLE "app"."matches" ADD COLUMN "stage" text DEFAULT 'final' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "group_number" integer;--> statement-breakpoint
ALTER TABLE "app"."participants" ADD COLUMN "advanced" boolean;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "group_stage_type" text;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "group_size" integer;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "started_at" timestamp with time zone;