import { BracketError, checkPlayers, identifierFor, type BracketMatch, type Slot } from "./types";

export type SingleEliminationOptions = {
  /** A match between the two semi-final losers, played before the final. */
  thirdPlace?: boolean;
};

/**
 * Seed positions in a bracket of `size` slots, top to bottom: 1, 8, 4, 5, 2, 7, 3, 6 for 8.
 * Seeds 1 and 2 can only meet in the final, 1 to 4 only in the semi-finals, and so on.
 */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, next - seed]);
  }
  return order;
}

/**
 * Builds a single-elimination bracket. `players` are in seed order, the first being seed 1.
 *
 * The bracket is the next power of 2 up. A slot with no player is a bye: there is no bye match;
 * the player facing it starts in round 2 instead, already placed there.
 */
export function buildSingleElimination(players: string[], options: SingleEliminationOptions = {}): BracketMatch[] {
  checkPlayers(players);
  if (options.thirdPlace && players.length < 4) throw new BracketError("A third-place match needs at least 4 players.");

  const size = 2 ** Math.ceil(Math.log2(players.length));
  const rounds = Math.log2(size);
  const playerAt = (seed: number) => players[seed - 1] ?? null;

  // Every match of every round, bye pairings of round 1 included for now: a bye's player is
  // carried into round 2 below, and the bye pairing itself is dropped.
  const grid: (BracketMatch | null)[][] = [];
  for (let round = 1; round <= rounds; round++) {
    const count = size / 2 ** round;
    grid.push(
      Array.from({ length: count }, (_, i) => ({
        key: `R${round}-${i + 1}`,
        identifier: "",
        round,
        playOrder: 0,
        thirdPlace: false,
        player1: null,
        player2: null,
        winner: null,
        winnerTo: round < rounds ? { match: `R${round + 1}-${Math.floor(i / 2) + 1}`, slot: ((i % 2) + 1) as Slot } : null,
        loserTo: null,
      })),
    );
  }

  const order = seedOrder(size);
  grid[0] = (grid[0] as BracketMatch[]).map((m, i) => {
    const [a, b] = [playerAt(order[2 * i]), playerAt(order[2 * i + 1])];
    if (a && b) return { ...m, player1: a, player2: b };
    // A bye: the player goes straight to round 2. In a bracket of 2 there is no bye.
    const next = grid[1][Math.floor(i / 2)]!;
    if (i % 2 === 0) next.player1 = a ?? b;
    else next.player2 = a ?? b;
    return null;
  });

  if (options.thirdPlace) {
    const semis = grid[rounds - 2] as BracketMatch[];
    for (const [i, semi] of semis.entries()) semi.loserTo = { match: "3P", slot: (i + 1) as Slot };
  }

  const matches = grid.flat().filter((m): m is BracketMatch => m !== null);
  if (options.thirdPlace) {
    // Played before the final, so the final closes the event.
    matches.splice(matches.length - 1, 0, {
      key: "3P",
      identifier: "3P",
      round: rounds,
      playOrder: 0,
      thirdPlace: true,
      player1: null,
      player2: null,
      winner: null,
      winnerTo: null,
      loserTo: null,
    });
  }

  let named = 0;
  return matches.map((m, i) => ({ ...m, playOrder: i + 1, identifier: m.thirdPlace ? "3P" : identifierFor(named++) }));
}
