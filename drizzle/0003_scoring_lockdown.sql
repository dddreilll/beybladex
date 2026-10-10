-- Same protections as 0001 for the M2 tables.
ALTER TABLE "app"."rule_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."battles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."sync_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."rule_profiles" ADD CONSTRAINT "rule_profiles_organizer_fk"
  FOREIGN KEY ("organizer_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
