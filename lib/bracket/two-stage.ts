import { seedOrder } from "./single-elimination";
import { placements } from "./standings";
import { swissFirstRoundPairs } from "./swiss";
import { BracketError, checkPlayers, type BracketMatch, type Format } from "./types";

/**
 * Splits players (in seed order) into groups by snaking: seeds go A, B, C, then C, B, A, and so
 * on, so every group gets a fair share of strong and weaker players. Each group stays in seed order.
 */
export function splitIntoGroups(players: string[], groupCount: number): string[][] {
  checkPlayers(players);
  if (!Number.isInteger(groupCount) || groupCount < 2) throw new BracketError("A group stage needs at least 2 groups.");
  if (players.length < groupCount * 2) throw new BracketError("Every group needs at least 2 players.");
  const groups: string[][] = Array.from({ length: groupCount }, () => []);
  players.forEach((player, i) => {
    const row = Math.floor(i / groupCount);
    const col = i % groupCount;
    groups[row % 2 ? groupCount - 1 - col : col].push(player);
  });
  return groups;
}

/**
 * A group's players, best first, once it is played out: its places, a shared place broken by seed.
 * A group that is a bracket is played to the end, so every player has a place.
 */
export function rankGroup(format: Format, players: string[], matches: BracketMatch[]): string[] {
  const seed = new Map(players.map((p, i) => [p, i]));
  return placements(format, players, matches)
    .sort((a, b) => a.place - b.place || seed.get(a.player)! - seed.get(b.player)!)
    .map((p) => p.player);
}

/** The seed pairs of the final stage's first round, where players from one group shouldn't meet. */
function firstRoundPairs(format: Format, players: number): [number, number][] {
  if (format === "round_robin") return [];
  if (format === "swiss") return swissFirstRoundPairs(players);
  const size = 2 ** Math.ceil(Math.log2(players));
  const order = seedOrder(size);
  const pairs: [number, number][] = [];
  for (let i = 0; i < size; i += 2) if (order[i] <= players && order[i + 1] <= players) pairs.push([order[i], order[i + 1]]);
  return pairs;
}

/**
 * The final stage's players in seed order. `ranked` holds each group's players best first (from
 * `rankGroup`), and the top `perGroup` of each go through: every group winner first, then every
 * runner-up, and so on. Within each of those tiers, players are then swapped so that, as far as
 * possible, nobody meets a player from their own group in the final stage's first round.
 */
export function seedFinalStage(ranked: string[][], perGroup: number, format: Format): string[] {
  if (ranked.length < 2) throw new BracketError("A group stage needs at least 2 groups.");
  if (!Number.isInteger(perGroup) || perGroup < 1) throw new BracketError("At least 1 player per group goes through.");
  if (ranked.some((group) => group.length <= perGroup)) throw new BracketError("Every group needs more players than go through.");

  const groupOf = new Map(ranked.flatMap((group, g) => group.map((p) => [p, g] as const)));
  const order: string[] = [];
  for (let tier = 0; tier < perGroup; tier++) for (const group of ranked) order.push(group[tier]);

  const pairs = firstRoundPairs(format, order.length);
  const clashes = () => pairs.filter(([a, b]) => groupOf.get(order[a - 1]) === groupOf.get(order[b - 1])).length;
  const tierOf = (seed: number) => Math.floor((seed - 1) / ranked.length);
  const swap = (a: number, b: number) => ([order[a - 1], order[b - 1]] = [order[b - 1], order[a - 1]]);

  // Swap the lower seed of a clash with another of its tier, keeping any swap that leaves fewer clashes.
  for (let pass = 0; pass < order.length; pass++) {
    const before = clashes();
    if (!before) break;
    for (const [high, low] of pairs) {
      if (groupOf.get(order[high - 1]) !== groupOf.get(order[low - 1])) continue;
      for (const seed of [low, high]) {
        const tier = tierOf(seed);
        const fixed = Array.from({ length: ranked.length }, (_, i) => tier * ranked.length + i + 1).some((other) => {
          if (other === seed) return false;
          const now = clashes();
          swap(seed, other);
          if (clashes() < now) return true;
          swap(seed, other);
          return false;
        });
        if (fixed) break;
      }
    }
    if (clashes() === before) break;
  }
  return order;
}
