import type { Stage, StagePhase } from "@/lib/challonge/support";

// Whether a tournament can be finalized, or its group stage ended, from what the app already knows
// (no Challonge request).

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What still stands in the way of finalizing; empty means ready.
 * Only *open* matches count as unplayed. A match left pending with nothing open is one Challonge
 * never opens: the last round of a bracket whose grand finals are set to None stays pending, and
 * Challonge finalizes all the same (spike S14). A grand-finals reset that isn't needed is removed
 * from the bracket (spike S16).
 * A Swiss tournament gets its rounds one at a time, so between rounds nothing is open although
 * rounds remain: `swissRounds` says how many there are in all.
 * A two-stage tournament is finalized from its final stage: `phase` says where it is. A Swiss
 * final stage's rounds start again at 1, so its rounds are counted without the groups'.
 */
export function finalizeBlockers(input: {
  matches: { state: string; round: number; stage?: Stage }[];
  unsent: number;
  swissRounds?: number | null;
  phase?: StagePhase | null;
}): string[] {
  if (input.phase === "groups") return ["The group stage is still being played."];
  if (input.phase === "between") return ["The final stage hasn't started yet."];
  const blockers: string[] = [];
  const open = input.matches.filter((m) => m.state === "open").length;
  const rounds = input.phase === "final" ? input.matches.filter((m) => m.stage !== "group") : input.matches;
  const lastRound = Math.max(0, ...rounds.map((m) => m.round));
  if (!input.matches.some((m) => m.state === "complete")) blockers.push("No match has been played yet.");
  else if (open > 0) blockers.push(`${plural(open, "match", "matches")} still to play.`);
  else if (input.swissRounds && lastRound < input.swissRounds) {
    blockers.push(`Round ${lastRound + 1} of ${input.swissRounds} isn't paired on Challonge yet. Resync in a moment.`);
  }
  if (input.unsent > 0) blockers.push(`${plural(input.unsent, "result isn't", "results aren't")} on Challonge yet.`);
  return blockers;
}

/**
 * What still stands in the way of ending the group stage of a two-stage tournament, given its group
 * matches; empty means ready. Between the rounds of a Swiss group nothing is open here although a
 * round may remain, and nothing says how many there are: Challonge then refuses, and says why.
 */
export function endGroupStageBlockers(input: { matches: { state: string }[]; unsent: number }): string[] {
  const blockers: string[] = [];
  const open = input.matches.filter((m) => m.state === "open").length;
  if (!input.matches.some((m) => m.state === "complete")) blockers.push("No match has been played yet.");
  else if (open > 0) blockers.push(`${plural(open, "match", "matches")} still to play.`);
  if (input.unsent > 0) blockers.push(`${plural(input.unsent, "result isn't", "results aren't")} on Challonge yet.`);
  return blockers;
}
