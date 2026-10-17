import { maxSwissRounds } from "@/lib/bracket/swiss";
import type { Format } from "./format";

// What has to be true of a tournament's setup before it can start. Pure: the create page, the
// Desk's setup view and startTournament ask the same questions.

export type Setup = {
  format: Format;
  /** How many players will play; null to check the options alone, before the players are all in. */
  players: number | null;
  thirdPlace: boolean;
  swissRounds: number | null;
  groupStage: { groups: number; advance: number } | null;
};

export const MAX_PLAYERS = 256;
const MAX_NAME = 60;

/**
 * Player names from what the organizer typed or pasted: one per line or separated by commas,
 * trimmed, blanks dropped. "Alex, Sam\nRiley" is three players.
 */
export function parsePlayerNames(text: string): string[] {
  return text
    .split(/[,\n\r]+/)
    .map((name) => name.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/** Why these names can't be added to a list that already has `existing`, or null. */
export function namesProblem(names: string[], existing: string[] = []): string | null {
  if (names.length === 0) return "Type at least one name.";
  const long = names.find((name) => name.length > MAX_NAME);
  if (long) return `"${long.slice(0, 20)}…" is longer than ${MAX_NAME} characters.`;
  const seen = new Set(existing.map((name) => name.toLowerCase()));
  for (const name of names) {
    if (seen.has(name.toLowerCase())) return `${name} is in the list twice.`;
    seen.add(name.toLowerCase());
  }
  if (seen.size > MAX_PLAYERS) return `A tournament has at most ${MAX_PLAYERS} players.`;
  return null;
}

/** How many players the final stage has: everyone, or who goes through from the groups. */
export const finalists = (setup: Pick<Setup, "players" | "groupStage">) =>
  setup.groupStage ? setup.groupStage.groups * setup.groupStage.advance : setup.players;

/**
 * What stands in the way of starting with this setup, worded for the organizer; empty means ready.
 * With `players` null only the options are checked, so a tournament can be created before its
 * players are all in.
 */
export function setupProblems(setup: Setup): string[] {
  const problems: string[] = [];
  const counted = setup.players !== null;
  const players = setup.players ?? 0;
  if (counted && players < 2) problems.push("A tournament needs at least 2 players.");
  if (setup.groupStage) {
    const { groups, advance } = setup.groupStage;
    const smallest = Math.floor(players / groups);
    if (groups < 2) problems.push("A group stage needs at least 2 groups.");
    else if (counted && players >= 2 && smallest < 2) problems.push(`${groups} groups need at least ${groups * 2} players.`);
    else if (counted && players >= 2 && advance >= smallest) problems.push(`With groups of ${smallest}, fewer than ${smallest} per group can go through.`);
    if (advance < 1) problems.push("At least 1 player per group goes through.");
    else if (groups * advance < 2) problems.push("At least 2 players must go through to the final stage.");
  }
  const final = finalists(setup);
  if (setup.thirdPlace && setup.format !== "single_elimination") problems.push("Only single elimination has a third-place match.");
  // The final stage's size is known from the groups alone, or once the players are counted.
  else if (setup.thirdPlace && final !== null && final < 4 && (setup.groupStage || players >= 2)) {
    problems.push("A third-place match needs at least 4 players in the final stage.");
  }
  if (setup.format === "swiss" && setup.swissRounds !== null && final !== null && final >= 2 && setup.swissRounds > maxSwissRounds(final)) {
    problems.push(`${final} players can play at most ${maxSwissRounds(final)} Swiss rounds.`);
  }
  return problems;
}
