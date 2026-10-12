-- Tells Supabase Realtime whenever a tournament's board changes, so call boards and control rooms
-- can refetch at once instead of asking every few seconds. The message goes to a public channel
-- named after the tournament's unguessable slug and carries only the new version number.
CREATE FUNCTION "app"."notify_board_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Screens still poll as a fallback: a Realtime problem must never block a call or a result.
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object('version', NEW.board_version),
      'changed',
      'board:' || NEW.public_slug,
      false
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Board change not sent to Realtime: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "tournaments_board_realtime"
  AFTER UPDATE OF "board_version" ON "app"."tournaments"
  FOR EACH ROW
  WHEN (OLD."board_version" IS DISTINCT FROM NEW."board_version")
  EXECUTE FUNCTION "app"."notify_board_change"();
