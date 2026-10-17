import { BracketError, type BracketMatch, type SlotRef } from "./types";

/**
 * Records the winner of a match and moves both players on: the winner along `winnerTo`, the loser
 * along `loserTo`. Returns new matches; the ones passed in are left alone.
 *
 * A match that already has a winner is refused here. Changing a result also clears the matches
 * it fed, which is a correction (milestone 2).
 */
export function recordWinner(matches: BracketMatch[], key: string, winner: string): BracketMatch[] {
  const next = matches.map((m) => ({ ...m }));
  const byKey = new Map(next.map((m) => [m.key, m]));
  const match = byKey.get(key);
  if (!match) throw new BracketError(`There is no match ${key}.`);
  if (!match.player1 || !match.player2) throw new BracketError(`Match ${match.identifier} doesn't have both players yet.`);
  if (match.winner) throw new BracketError(`Match ${match.identifier} already has a winner.`);
  if (winner !== match.player1 && winner !== match.player2) throw new BracketError(`That player isn't in match ${match.identifier}.`);

  const loser = winner === match.player1 ? match.player2 : match.player1;
  const place = (to: SlotRef | null, player: string) => {
    if (!to) return;
    const target = byKey.get(to.match);
    if (!target) throw new BracketError(`Match ${match.identifier} leads to a match that doesn't exist.`);
    if (to.slot === 1) target.player1 = player;
    else target.player2 = player;
  };

  match.winner = winner;
  place(match.winnerTo, winner);
  place(match.loserTo, loser);
  return next;
}

/** Matches that can be played now: both players known, no winner yet. */
export const openMatches = (matches: BracketMatch[]): BracketMatch[] =>
  matches.filter((m) => m.player1 && m.player2 && !m.winner);
