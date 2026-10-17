ALTER TABLE "app"."api_usage" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."challonge_connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."sync_outbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "app"."api_usage" CASCADE;--> statement-breakpoint
DROP TABLE "app"."challonge_connections" CASCADE;--> statement-breakpoint
DROP TABLE "app"."sync_outbox" CASCADE;--> statement-breakpoint
DROP INDEX "app"."matches_tournament_challonge_idx";--> statement-breakpoint
DROP INDEX "app"."matches_tournament_order_idx";--> statement-breakpoint
DROP INDEX "app"."participants_tournament_challonge_idx";--> statement-breakpoint
DROP INDEX "app"."player_sessions_player_idx";--> statement-breakpoint
DROP INDEX "app"."push_subscriptions_player_idx";--> statement-breakpoint
DROP INDEX "app"."tournaments_organizer_challonge_idx";--> statement-breakpoint
ALTER TABLE "app"."matches" DROP COLUMN "challonge_id";--> statement-breakpoint
ALTER TABLE "app"."matches" DROP COLUMN "suggested_play_order";--> statement-breakpoint
ALTER TABLE "app"."matches" DROP COLUMN "player1_challonge_id";--> statement-breakpoint
ALTER TABLE "app"."matches" DROP COLUMN "player2_challonge_id";--> statement-breakpoint
ALTER TABLE "app"."matches" DROP COLUMN "winner_challonge_id";--> statement-breakpoint
ALTER TABLE "app"."matches" DROP COLUMN "score_in_sets";--> statement-breakpoint
ALTER TABLE "app"."matches" DROP COLUMN "underway_at";--> statement-breakpoint
ALTER TABLE "app"."matches" DROP COLUMN "winner_next_challonge_id";--> statement-breakpoint
ALTER TABLE "app"."matches" DROP COLUMN "loser_next_challonge_id";--> statement-breakpoint
ALTER TABLE "app"."participants" DROP COLUMN "challonge_id";--> statement-breakpoint
ALTER TABLE "app"."player_sessions" DROP COLUMN "participant_challonge_id";--> statement-breakpoint
ALTER TABLE "app"."push_subscriptions" DROP COLUMN "participant_challonge_id";--> statement-breakpoint
ALTER TABLE "app"."tournaments" DROP COLUMN "challonge_id";--> statement-breakpoint
ALTER TABLE "app"."tournaments" DROP COLUMN "challonge_url";--> statement-breakpoint
ALTER TABLE "app"."tournaments" DROP COLUMN "community_id";--> statement-breakpoint
ALTER TABLE "app"."tournaments" DROP COLUMN "group_size";--> statement-breakpoint
ALTER TABLE "app"."tournaments" DROP COLUMN "participants_count";--> statement-breakpoint
ALTER TABLE "app"."tournaments" DROP COLUMN "matches_etag";--> statement-breakpoint
ALTER TABLE "app"."tournaments" DROP COLUMN "last_synced_at";--> statement-breakpoint
ALTER TABLE "app"."tournaments" DROP COLUMN "mark_underway";--> statement-breakpoint
DROP TYPE "app"."connection_status";--> statement-breakpoint
DROP TYPE "app"."outbox_status";