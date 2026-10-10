CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "app"."connection_status" AS ENUM('credentials_saved', 'connected', 'reconnect_required');--> statement-breakpoint
CREATE TABLE "app"."api_usage" (
	"connection_id" uuid NOT NULL,
	"month" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_usage_connection_id_month_pk" PRIMARY KEY("connection_id","month")
);
--> statement-breakpoint
CREATE TABLE "app"."challonge_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text,
	"challonge_user_id" text,
	"challonge_username" text,
	"status" "app"."connection_status" DEFAULT 'credentials_saved' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challonge_connections_organizer_id_unique" UNIQUE("organizer_id")
);
--> statement-breakpoint
CREATE TABLE "app"."matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"challonge_id" text NOT NULL,
	"identifier" text NOT NULL,
	"round" integer NOT NULL,
	"suggested_play_order" integer,
	"state" text NOT NULL,
	"player1_challonge_id" text,
	"player2_challonge_id" text,
	"winner_challonge_id" text,
	"scores" text,
	"score_in_sets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"underway_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"challonge_id" text NOT NULL,
	"name" text NOT NULL,
	"seed" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."tournaments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"challonge_id" text NOT NULL,
	"challonge_url" text NOT NULL,
	"community_id" text,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"tournament_type" text NOT NULL,
	"participants_count" integer DEFAULT 0 NOT NULL,
	"matches_etag" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."api_usage" ADD CONSTRAINT "api_usage_connection_id_challonge_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "app"."challonge_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."matches" ADD CONSTRAINT "matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "app"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."participants" ADD CONSTRAINT "participants_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "app"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "matches_tournament_challonge_idx" ON "app"."matches" USING btree ("tournament_id","challonge_id");--> statement-breakpoint
CREATE INDEX "matches_tournament_order_idx" ON "app"."matches" USING btree ("tournament_id","suggested_play_order");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_tournament_challonge_idx" ON "app"."participants" USING btree ("tournament_id","challonge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tournaments_organizer_challonge_idx" ON "app"."tournaments" USING btree ("organizer_id","challonge_id");