import { buildDoubleElimination } from "@/lib/bracket/double-elimination";
import { buildRoundRobin } from "@/lib/bracket/round-robin";
import { buildSingleElimination } from "@/lib/bracket/single-elimination";
import { pairSwissRound, suggestedSwissRounds } from "@/lib/bracket/swiss";
import type { BracketMatch, Format } from "@/lib/bracket/types";

export type StageOptions = {
  grandFinal: "reset" | "single";
  thirdPlace: boolean;
  roundRobinLegs: number;
};

/**
 * The matches a stage starts with: the whole bracket or schedule, or a Swiss's first round.
 * `players` are in seed order. A group stage has no third-place match; that belongs to the final.
 */
export function buildStage(format: Format, players: string[], options: StageOptions): BracketMatch[] {
  switch (format) {
    case "single_elimination":
      return buildSingleElimination(players, { thirdPlace: options.thirdPlace && players.length >= 4 });
    case "double_elimination":
      return buildDoubleElimination(players, { grandFinal: options.grandFinal });
    case "round_robin":
      return buildRoundRobin(players, { legs: options.roundRobinLegs === 2 ? 2 : 1 });
    case "swiss":
      return pairSwissRound(players, []);
  }
}

/** How many rounds a Swiss stage plays: the organizer's number for the tournament, else the suggestion for its players. */
export const swissRoundsFor = (players: number, chosen: number | null) => chosen ?? suggestedSwissRounds(players);

/**
 * Whether a Swiss stage needs its next round paired now: every match of its latest round has a
 * result, and rounds remain.
 */
export function swissRoundDue(matches: BracketMatch[], rounds: number): boolean {
  const latest = Math.max(0, ...matches.map((m) => m.round));
  return latest > 0 && latest < rounds && matches.filter((m) => m.round === latest).every((m) => m.winner);
}
