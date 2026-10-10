-- The app schema is only reached through the server (Drizzle, as the table owner).
-- Keep Supabase's API roles out of it entirely, even if the schema is ever exposed via the Data API.
REVOKE ALL ON SCHEMA "app" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
ALTER TABLE "app"."challonge_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."api_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Deleting an organizer's account removes their Challonge credentials and tournaments.
ALTER TABLE "app"."challonge_connections" ADD CONSTRAINT "challonge_connections_organizer_fk"
  FOREIGN KEY ("organizer_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD CONSTRAINT "tournaments_organizer_fk"
  FOREIGN KEY ("organizer_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
