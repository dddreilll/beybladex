import { BracketError, type BracketMatch, type SlotRef } from "./types";

const copy = (matches: BracketMatch[]) => matches.map((m) => ({ ...m }));

function find(matches: BracketMatch[], key: string, winner: string): BracketMatch {
  const match = matches.find((m) => m.key === key);
  if (!match) throw new BracketError(`There is no match ${key}.`);
  if (!match.player1 || !match.player2) throw new BracketError(`Match ${match.identifier} doesn't have both players yet.`);
  if (winner !== match.player1 && winner !== match.player2) throw new BracketError(`That player isn't in match ${match.identifier}.`);
  return match;
}

/**
 * Records the winner of a match and moves both players on: the winner along `winnerTo`, the loser
 * along `loserTo`. Returns new matches; the ones passed in are left alone.
 *
 * A match that already has a winner is refused here: changing it is a correction (`correctWinner`).
 */
export function recordWinner(matches: BracketMatch[], key: string, winner: string): BracketMatch[] {
  const next = copy(matches);
  const byKey = new Map(next.map((m) => [m.key, m]));
  const match = find(next, key, winner);
  if (match.winner) throw new BracketError(`Match ${match.identifier} already has a winner.`);

  match.winner = winner;
  // A grand final won by the winners-bracket player needs no reset.
  if (match.winnerTo && byKey.get(match.winnerTo.match)?.ifNeeded && winner === match.player1) return next;

  const loser = winner === match.player1 ? match.player2! : match.player1!;
  const place = (to: SlotRef | null, player: string) => {
    if (!to) return;
    const target = byKey.get(to.match);
    if (!target) throw new BracketError(`Match ${match.identifier} leads to a match that doesn't exist.`);
    if (to.slot === 1) target.player1 = player;
    else target.player2 = player;
  };
  place(match.winnerTo, winner);
  place(match.loserTo, loser);
  return next;
}

/**
 * Changes the winner of a match that already has one. Every later match the old result reached
 * loses the player it was given and, if it was played, its result too, all the way down. Those
 * erased results are returned in play order, so they can be shown to the organizer before
 * anything is changed: call this, ask, and keep `matches` only if they confirm.
 */
export function correctWinner(matches: BracketMatch[], key: string, winner: string): { matches: BracketMatch[]; erased: string[] } {
  const next = copy(matches);
  const byKey = new Map(next.map((m) => [m.key, m]));
  const match = find(next, key, winner);
  if (!match.winner) throw new BracketError(`Match ${match.identifier} has no winner to correct.`);
  if (match.winner === winner) return { matches: next, erased: [] };

  const erased: BracketMatch[] = [];
  const unplay = (m: BracketMatch) => {
    if (!m.winner) return;
    m.winner = null;
    for (const to of [m.winnerTo, m.loserTo]) {
      if (!to) continue;
      const target = byKey.get(to.match)!;
      if (to.slot === 1) target.player1 = null;
      else target.player2 = null;
      if (target.winner) erased.push(target);
      unplay(target);
    }
  };
  unplay(match);

  return {
    matches: recordWinner(next, key, winner),
    erased: erased.sort((a, b) => a.playOrder - b.playOrder).map((m) => m.key),
  };
}

/** Matches that can be played now: both players known, no winner yet. */
export const openMatches = (matches: BracketMatch[]): BracketMatch[] =>
  matches.filter((m) => m.player1 && m.player2 && !m.winner);

/**
 * The winner of an elimination bracket once it is decided, else null. Not for a round robin, which
 * has standings, not a champion.
 */
export function champion(matches: BracketMatch[]): string | null {
  const reset = matches.find((m) => m.ifNeeded);
  const final = matches.find((m) => !m.thirdPlace && !m.ifNeeded && (!m.winnerTo || m.winnerTo.match === reset?.key));
  if (!final?.winner) return null;
  if (reset && final.winner !== final.player1) return reset.winner;
  return final.winner;
}
