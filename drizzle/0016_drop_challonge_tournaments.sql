-- BXQ runs its own brackets from here on and no longer imports from Challonge. Tournaments imported
-- from Challonge are dropped, with everything that belongs to them (players, matches, battles,
-- stadiums, screens, sessions, push subscriptions), before their Challonge columns go.
DELETE FROM "app"."tournaments";
