// BXQ's own bracket engine. Pure: players in, matches out. Nothing here reads or writes the database.

/** A player's place in a match: player 1 or player 2. */
export type Slot = 1 | 2;

/** Where a match sends one of its players once it has a winner. */
export type SlotRef = { match: string; slot: Slot };

export type BracketMatch = {
  /** Stable within a bracket, e.g. "R2-1" or "3P". */
  key: string;
  /** What the screens show: A, B, … Z, AA, AB, …, or 3P for the third-place match. */
  identifier: string;
  round: number;
  /** The order to play the matches in, from 1. */
  playOrder: number;
  thirdPlace: boolean;
  /** Double elimination only; absent in the winners bracket and in every other format. */
  section?: "losers" | "grand_final";
  /** The grand-final reset: played only if the losers-bracket player wins the first grand final. */
  ifNeeded?: boolean;
  /** A Swiss bye: player 1 sits the round out and is given the win. Never played. */
  bye?: boolean;
  /** Beyblade X points scored by player 1 and player 2, for the points-difference tie-break. */
  score?: [number, number];
  /** Player ids, or null while the slot waits for an earlier match. */
  player1: string | null;
  player2: string | null;
  winner: string | null;
  winnerTo: SlotRef | null;
  loserTo: SlotRef | null;
};

export type Format = "single_elimination" | "double_elimination" | "round_robin" | "swiss";

export const isElimination = (format: Format) => format === "single_elimination" || format === "double_elimination";

export class BracketError extends Error {
  name = "BracketError";
}

/** A, B, … Z, AA, AB, … for the 1st, 2nd, … match, as Challonge names them. */
export function identifierFor(index: number): string {
  let n = index;
  let id = "";
  do {
    id = String.fromCharCode(65 + (n % 26)) + id;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

/** At least two players, none twice, none blank. */
export function checkPlayers(players: string[]): void {
  if (players.length < 2) throw new BracketError("A bracket needs at least 2 players.");
  if (players.some((p) => !p)) throw new BracketError("Every player needs an id.");
  if (new Set(players).size !== players.length) throw new BracketError("A player is in the list twice.");
}
