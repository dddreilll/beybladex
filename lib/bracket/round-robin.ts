import { BracketError, checkPlayers, identifierFor, type BracketMatch } from "./types";

export type RoundRobinOptions = {
  /** 1: every pair meets once. 2: twice, the second time with the sides swapped. */
  legs?: 1 | 2;
};

/**
 * Builds a round robin by the circle method: the first player stays put and the others rotate one
 * place each round, so every pair meets exactly once per leg and nobody plays twice in a round.
 * With an odd number of players, one player sits out each round; that is not a match.
 */
export function buildRoundRobin(players: string[], options: RoundRobinOptions = {}): BracketMatch[] {
  checkPlayers(players);
  const legs = options.legs ?? 1;
  if (legs !== 1 && legs !== 2) throw new BracketError("A round robin is played once or twice.");

  const circle: (string | null)[] = players.length % 2 ? [...players, null] : [...players];
  const n = circle.length;
  const pairings: [string, string][][] = [];

  for (let r = 0; r < n - 1; r++) {
    const round: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const [a, b] = [circle[i], circle[n - 1 - i]];
      if (!a || !b) continue;
      // The fixed player alternates sides from round to round, so sides come out even.
      round.push(i === 0 && r % 2 ? [b, a] : [a, b]);
    }
    pairings.push(round);
    circle.splice(1, 0, circle.pop()!);
  }
  if (legs === 2) pairings.push(...pairings.map((round) => round.map(([a, b]): [string, string] => [b, a])));

  return pairings.flatMap((round, r) =>
    round.map(([player1, player2], i) => ({
      key: `R${r + 1}-${i + 1}`,
      identifier: "",
      round: r + 1,
      playOrder: 0,
      thirdPlace: false,
      player1,
      player2,
      winner: null,
      winnerTo: null,
      loserTo: null,
    })),
  ).map((m, i) => ({ ...m, playOrder: i + 1, identifier: identifierFor(i) }));
}
