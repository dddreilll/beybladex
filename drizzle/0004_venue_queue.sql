CREATE TYPE "app"."call_status" AS ENUM('none', 'on_deck', 'called', 'playing');--> statement-breakpoint
CREATE TABLE "app"."stadiums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "stadium_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "call_status" "app"."call_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "called_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "playing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD COLUMN "held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "public_slug" text DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "board_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "auto_call" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD COLUMN "mark_underway" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."stadiums" ADD CONSTRAINT "stadiums_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "app"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stadiums_tournament_idx" ON "app"."stadiums" USING btree ("tournament_id","position");--> statement-breakpoint
ALTER TABLE "app"."matches" ADD CONSTRAINT "matches_stadium_id_stadiums_id_fk" FOREIGN KEY ("stadium_id") REFERENCES "app"."stadiums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD CONSTRAINT "tournaments_public_slug_unique" UNIQUE("public_slug");