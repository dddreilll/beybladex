import type { BracketMatch } from "@/lib/bracket/types";
import type { Stage } from "./format";

// How the bracket engine's matches (lib/bracket) are kept in the matches table, and back. Pure.

/** The columns of a match row the engine reads and writes. */
export type BracketRow = {
  key: string;
  number: number | null;
  round: number;
  playOrder: number;
  thirdPlace: boolean;
  section: "losers" | "grand_final" | null;
  ifNeeded: boolean;
  bye: boolean;
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  winnerTo: BracketMatch["winnerTo"];
  loserTo: BracketMatch["loserTo"];
};

/** What a row says about a match: "open" with both players and no winner, "complete" with a winner, "pending" otherwise. */
export const stateOf = (m: Pick<BracketMatch, "player1" | "player2" | "winner">) =>
  m.winner ? "complete" : m.player1 && m.player2 ? "open" : "pending";

export function toBracket(row: BracketRow): BracketMatch {
  return {
    key: row.key,
    ...(row.number !== null && { number: row.number }),
    round: row.round,
    playOrder: row.playOrder,
    thirdPlace: row.thirdPlace,
    ...(row.section && { section: row.section }),
    ...(row.ifNeeded && { ifNeeded: true }),
    ...(row.bye && { bye: true }),
    player1: row.player1Id,
    player2: row.player2Id,
    winner: row.winnerId,
    winnerTo: row.winnerTo,
    loserTo: row.loserTo,
  };
}

/** A new match row for a stage (and a group in it), from the engine's match. Its number comes from `numberMatches`. */
export function toRow(m: BracketMatch, place: { tournamentId: string; stage: Stage; groupNumber: number | null }) {
  return {
    tournamentId: place.tournamentId,
    stage: place.stage,
    groupNumber: place.groupNumber,
    key: m.key,
    round: m.round,
    playOrder: m.playOrder,
    thirdPlace: m.thirdPlace,
    section: m.section ?? null,
    ifNeeded: m.ifNeeded ?? false,
    bye: m.bye ?? false,
    player1Id: m.player1,
    player2Id: m.player2,
    winnerId: m.winner,
    winnerTo: m.winnerTo,
    loserTo: m.loserTo,
    state: stateOf(m),
  };
}

/**
 * Numbers new matches from `first` ("Match 12"), in the order the queue plays them: by play
 * order, then group, so the matches of the groups take turns. A Swiss bye is never played, so it
 * gets no number.
 */
export function numberMatches<R extends { playOrder: number; groupNumber: number | null; bye: boolean }>(rows: R[], first: number): (R & { number: number | null })[] {
  const order = rows.filter((r) => !r.bye).sort((a, b) => a.playOrder - b.playOrder || (a.groupNumber ?? 0) - (b.groupNumber ?? 0));
  const numberOf = new Map(order.map((r, i) => [r, first + i]));
  return rows.map((r) => ({ ...r, number: numberOf.get(r) ?? null }));
}

/** The key prefix of a group's matches, so keys stay unique across the groups of a tournament. */
export const groupPrefix = (groupNumber: number | null) => (groupNumber ? `G${groupNumber}:` : "");

/** Prefixes every key of a stage's matches, links included. */
export function prefixKeys(matches: BracketMatch[], prefix: string): BracketMatch[] {
  if (!prefix) return matches;
  const ref = (to: BracketMatch["winnerTo"]) => (to ? { ...to, match: prefix + to.match } : null);
  return matches.map((m) => ({ ...m, key: prefix + m.key, winnerTo: ref(m.winnerTo), loserTo: ref(m.loserTo) }));
}

export type MatchChange = {
  key: string;
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  state: string;
  /** It had a player it no longer has: whatever was played in it no longer counts. */
  lostPlayer: boolean;
};

/** The matches whose players or winner the engine changed, as the columns to write. */
export function changes(before: BracketMatch[], after: BracketMatch[]): MatchChange[] {
  const old = new Map(before.map((m) => [m.key, m]));
  return after.flatMap((m) => {
    const was = old.get(m.key);
    if (!was || (was.player1 === m.player1 && was.player2 === m.player2 && was.winner === m.winner)) return [];
    const lostPlayer = [was.player1, was.player2].some((p) => p !== null && p !== m.player1 && p !== m.player2);
    return [{ key: m.key, player1Id: m.player1, player2Id: m.player2, winnerId: m.winner, state: stateOf(m), lostPlayer }];
  });
}
