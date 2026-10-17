import { BracketError, checkPlayers, type BracketMatch } from "./types";

/** The most rounds a Swiss can have before somebody would have to meet an opponent again. */
export const maxSwissRounds = (players: number) => (players % 2 ? players : players - 1);

/** Enough rounds to leave one player unbeaten: 5 for 17 to 32 players. The organizer can change it. */
export function suggestedSwissRounds(players: number): number {
  if (players < 2) throw new BracketError("A Swiss needs at least 2 players.");
  return Math.min(Math.ceil(Math.log2(players)), maxSwissRounds(players));
}

/** Seed pairs of round 1, top half against bottom half: 1 v 9, 2 v 10, … of 16. With an odd count the last seed has the bye. */
export function swissFirstRoundPairs(players: number): [number, number][] {
  const half = Math.floor(players / 2);
  return Array.from({ length: half }, (_, i) => [i + 1, i + 1 + half]);
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** How many tries the search for a pairing without rematches gets before rematches are allowed. */
const SEARCH_LIMIT = 50_000;

/**
 * Pairs the next round of a Swiss. `players` are the players still in, in seed order; `played`
 * holds every earlier match of the Swiss, byes included, and all of them must have a winner.
 *
 * Players are ranked by wins, then seed. Within a group on the same wins the top half meets the
 * bottom half (round 1 is one such group, so it goes 1 v 9 of 16); a group with an odd count sends
 * its last player down to the next group. Nobody meets an opponent twice if it can be avoided.
 * With an odd count, the lowest-ranked player who hasn't had a bye sits out and is given the win.
 */
export function pairSwissRound(players: string[], played: BracketMatch[]): BracketMatch[] {
  checkPlayers(players);
  const unfinished = played.find((m) => !m.winner);
  if (unfinished) throw new BracketError(`Round ${unfinished.round} isn't finished yet.`);
  const round = Math.max(0, ...played.map((m) => m.round)) + 1;
  if (round > maxSwissRounds(players.length)) throw new BracketError("Everyone has already met everyone.");

  const seed = new Map(players.map((p, i) => [p, i]));
  const wins = new Map<string, number>();
  const met = new Set<string>();
  const hadBye = new Set<string>();
  for (const m of played) {
    wins.set(m.winner!, (wins.get(m.winner!) ?? 0) + 1);
    if (m.bye) hadBye.add(m.player1!);
    else met.add(pairKey(m.player1!, m.player2!));
  }
  const winsOf = (p: string) => wins.get(p) ?? 0;
  const ranked = [...players].sort((a, b) => winsOf(b) - winsOf(a) || seed.get(a)! - seed.get(b)!);

  const byeCandidates = players.length % 2 ? [...ranked].reverse() : [null];
  const freshBye = byeCandidates.filter((p) => p === null || !hadBye.has(p));
  let pairs: [string, string][] | null = null;
  let bye: string | null = null;
  for (const allowRematch of [false, true]) {
    const budget = { left: SEARCH_LIMIT };
    for (const candidate of freshBye.length ? freshBye : byeCandidates) {
      pairs = pairUp(ranked.filter((p) => p !== candidate), winsOf, allowRematch ? null : met, budget);
      if (pairs) {
        bye = candidate;
        break;
      }
    }
    if (pairs) break;
  }

  const lastOrder = Math.max(0, ...played.map((m) => m.playOrder));
  const matches: BracketMatch[] = pairs!.map(([player1, player2], i) => ({
    key: `R${round}-${i + 1}`,
    round,
    playOrder: lastOrder + i + 1,
    thirdPlace: false,
    player1,
    player2,
    winner: null,
    winnerTo: null,
    loserTo: null,
  }));
  if (bye) {
    matches.push({
      key: `R${round}-bye`,
      round,
      playOrder: lastOrder + matches.length + 1,
      thirdPlace: false,
      bye: true,
      player1: bye,
      player2: null,
      winner: bye,
      winnerTo: null,
      loserTo: null,
    });
  }
  return matches;
}

/** Pairs everyone in `pool` (ranked best first), or returns null. `met` null allows rematches. */
function pairUp(
  pool: string[],
  winsOf: (p: string) => number,
  met: Set<string> | null,
  budget: { left: number },
): [string, string][] | null {
  if (!pool.length) return [];
  if (--budget.left < 0) return null;
  const [player, ...rest] = pool;
  for (const opponent of preferred(player, rest, winsOf)) {
    if (met?.has(pairKey(player, opponent))) continue;
    const tail = pairUp(
      rest.filter((p) => p !== opponent),
      winsOf,
      met,
      budget,
    );
    if (tail) return [[player, opponent], ...tail];
  }
  return null;
}

/**
 * The opponents `player` (the best left) should meet, best first: the top of the bottom half of
 * its own group, then down that half, then up the top half; then the players of lower groups, the
 * nearest group first.
 */
function preferred(player: string, rest: string[], winsOf: (p: string) => number): string[] {
  const group = rest.filter((p) => winsOf(p) === winsOf(player));
  const target = Math.floor((group.length + 1) / 2) - 1;
  const own = [...group.slice(Math.max(target, 0)), ...group.slice(0, Math.max(target, 0)).reverse()];
  return [...own, ...rest.filter((p) => winsOf(p) !== winsOf(player))];
}
