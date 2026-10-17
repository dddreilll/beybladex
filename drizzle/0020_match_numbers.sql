ALTER TABLE "app"."matches" ADD COLUMN "number" integer;--> statement-breakpoint
-- Matches made before numbering: groups first, then the final stage, each in queue order. Byes get none.
UPDATE "app"."matches" AS m SET "number" = n."number"
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "tournament_id" ORDER BY ("stage" = 'final'), "play_order", "group_number", "key") AS "number"
  FROM "app"."matches"
  WHERE NOT "bye"
) AS n
WHERE m."id" = n."id";--> statement-breakpoint
CREATE UNIQUE INDEX "matches_tournament_number_idx" ON "app"."matches" USING btree ("tournament_id","number");
