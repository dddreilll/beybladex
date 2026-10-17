import { standings } from "@/lib/bracket/standings";
import type { BracketMatch } from "@/lib/bracket/types";
import { groupLabel } from "@/lib/tournament/labels";
import { isElimination, stagePhase, stageType, type Stage } from "@/lib/tournament/format";

// Running standings for the formats where everyone keeps playing: a round robin, Swiss, every
// group of a two-stage tournament, and a final stage that is a round robin or Swiss. Worked out
// from the stored results by the bracket engine (lib/bracket/standings.ts): wins, then Buchholz,
// head-to-head and Beyblade X points difference. They are the places once the stage is over.

export type StandingRow = {
  playerId: string;
  name: string;
  wins: number;
  losses: number;
  /** The wins of every opponent met, added up. */
  buchholz: number;
  /** 1 for the best; every tie is broken, down to the seed. */
  rank: number;
  /** "2-1". */
  record: string;
  /** Whether the player went on to the final stage; null until a group stage has ended, and outside one. */
  advanced: boolean | null;
  /** Dropped out of the tournament. */
  dropped: boolean;
};

export type StandingsTable = {
  /** "all", "final", or "group-1". */
  key: string;
  title: string;
  /** Whether its stage is the one being played (the groups until the final stage starts). */
  current: boolean;
  rows: StandingRow[];
};

type StandingsMatch = {
  stage: Stage;
  groupNumber: number | null;
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  scores: string | null;
  bye: boolean;
};
type StandingsPlayer = {
  id: string;
  name: string;
  active: boolean;
  advanced: boolean | null;
  seed: number | null;
  finalSeed: number | null;
  groupNumber: number | null;
};
type StandingsFormat = { tournamentType: string; groupStage: boolean; groupStageType?: string | null; state: string };

/** The points each player scored in a match, from its score as players read it: "4-2", or "4-1,2-4" with sets. */
export function pointsOf(scores: string | null): [number, number] | undefined {
  const sets = (scores ?? "").split(",").map((set) => /^(\d+)-(\d+)$/.exec(set.trim()));
  if (!scores || sets.some((s) => !s)) return undefined;
  return sets.reduce<[number, number]>((sum, s) => [sum[0] + Number(s![1]), sum[1] + Number(s![2])], [0, 0]);
}

const asBracket = (m: StandingsMatch): BracketMatch => ({
  key: "",
  round: 0,
  playOrder: 0,
  thirdPlace: false,
  bye: m.bye,
  player1: m.player1Id,
  player2: m.player2Id,
  winner: m.winnerId,
  winnerTo: null,
  loserTo: null,
  score: pointsOf(m.scores),
});

/** The standings of these players, in seed order, from these matches. */
function table(matches: StandingsMatch[], players: StandingsPlayer[]): StandingRow[] {
  const byId = new Map(players.map((p) => [p.id, p]));
  return standings(
    players.map((p) => p.id),
    matches.map(asBracket),
  ).map((r) => ({
    playerId: r.player,
    name: byId.get(r.player)!.name,
    wins: r.wins,
    losses: r.losses,
    buchholz: r.buchholz,
    rank: r.rank,
    record: `${r.wins}-${r.losses}`,
    advanced: byId.get(r.player)!.advanced,
    dropped: !byId.get(r.player)!.active,
  }));
}

const bySeed = (seedOf: (p: StandingsPlayer) => number | null) => (a: StandingsPlayer, b: StandingsPlayer) =>
  (seedOf(a) ?? Number.MAX_SAFE_INTEGER) - (seedOf(b) ?? Number.MAX_SAFE_INTEGER);

/**
 * Every standings table of a tournament, the stage being played first; empty for a single or
 * double elimination bracket without groups, where a bracket says more than a record.
 */
export function standingsTables(format: StandingsFormat, matches: StandingsMatch[], players: StandingsPlayer[]): StandingsTable[] {
  const phase = stagePhase(format);
  const seeded = [...players].sort(bySeed((p) => p.seed));

  if (!phase) {
    if (isElimination(format.tournamentType) || format.state === "pending") return [];
    return [{ key: "all", title: "Standings", current: true, rows: table(matches, seeded) }];
  }

  const groupMatches = matches.filter((m) => m.stage === "group");
  const numbers = [...new Set(seeded.map((p) => p.groupNumber).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  const groups: StandingsTable[] = numbers.map((n) => ({
    key: `group-${n}`,
    title: groupLabel(n),
    current: phase !== "final",
    rows: table(
      groupMatches.filter((m) => m.groupNumber === n),
      seeded.filter((p) => p.groupNumber === n),
    ),
  }));

  const finalMatches = matches.filter((m) => m.stage === "final");
  if (phase !== "final" || isElimination(stageType(format, "final")) || finalMatches.length === 0) return groups;
  // Who didn't go through has no place here: the final stage is its own competition.
  const finalists = players.filter((p) => p.advanced).sort(bySeed((p) => p.finalSeed));
  const final: StandingsTable = { key: "final", title: "Final stage", current: true, rows: table(finalMatches, finalists) };
  return [final, ...groups];
}
