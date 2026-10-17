import type { Stage, StagePhase } from "@/lib/tournament/format";

// Whether a tournament can be finished, or its group stage ended, from its stored matches.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What still stands in the way of finishing; empty means ready. Only *open* matches count as
 * unplayed: a grand-final reset that wasn't needed never gets its players, so it never opens.
 * A Swiss gets its rounds one at a time, so between rounds nothing is open although rounds
 * remain: `swissRounds` says how many there are in all. A two-stage tournament is finished from
 * its final stage, whose rounds are counted without the groups'.
 */
export function finalizeBlockers(input: {
  matches: { state: string; round: number; stage?: Stage }[];
  swissRounds?: number | null;
  phase?: StagePhase | null;
}): string[] {
  if (input.phase === "groups") return ["The group stage is still being played."];
  if (input.phase === "between") return ["The final stage hasn't started yet."];
  const rounds = input.matches.filter((m) => m.stage !== "group");
  const open = rounds.filter((m) => m.state === "open").length;
  const lastRound = Math.max(0, ...rounds.map((m) => m.round));
  if (open > 0) return [`${plural(open, "match", "matches")} still to play.`];
  if (!rounds.some((m) => m.state === "complete")) return ["No match has been played yet."];
  if (input.swissRounds && lastRound < input.swissRounds) return [`Round ${lastRound + 1} of ${input.swissRounds} isn't paired yet.`];
  return [];
}

/** What still stands in the way of ending the group stage, given its group matches; empty means ready. */
export function endGroupStageBlockers(input: { matches: { state: string }[] }): string[] {
  const open = input.matches.filter((m) => m.state === "open").length;
  if (!input.matches.some((m) => m.state === "complete")) return ["No match has been played yet."];
  if (open > 0) return [`${plural(open, "match", "matches")} still to play.`];
  return [];
}
