// Challonge doesn't expose which match feeds which (spike S3), so we learn it: after a result is
// reported, the match a player newly appears in is where they advanced to.

export type MatchSlots = {
  challongeId: string;
  state: string;
  player1ChallongeId: string | null;
  player2ChallongeId: string | null;
};

const hasPlayer = (m: MatchSlots, playerId: string) => m.player1ChallongeId === playerId || m.player2ChallongeId === playerId;

export function learnProgression(
  before: MatchSlots[],
  after: MatchSlots[],
  reported: { challongeId: string; winnerId: string; loserId: string },
): { winnerNext: string | null; loserNext: string | null } {
  const previous = new Map(before.map((m) => [m.challongeId, m]));
  const arrivedIn = (playerId: string) =>
    after.find((m) => {
      if (m.challongeId === reported.challongeId || !hasPlayer(m, playerId)) return false;
      const was = previous.get(m.challongeId);
      return !was || !hasPlayer(was, playerId);
    })?.challongeId ?? null;

  return { winnerNext: arrivedIn(reported.winnerId), loserNext: arrivedIn(reported.loserId) };
}

/** Matches that were complete before and aren't any more: Challonge wiped their result (spike S4b). */
export function findResetMatches(before: MatchSlots[], after: MatchSlots[], exceptChallongeId: string): string[] {
  const now = new Map(after.map((m) => [m.challongeId, m]));
  return before
    .filter((m) => m.challongeId !== exceptChallongeId && m.state === "complete")
    .filter((m) => {
      const current = now.get(m.challongeId);
      return !current || current.state !== "complete";
    })
    .map((m) => m.challongeId);
}
