import { seedOrder } from "./single-elimination";
import { BracketError, checkPlayers, type BracketMatch, type Slot, type SlotRef } from "./types";

export type DoubleEliminationOptions = {
  /**
   * "reset": if the losers-bracket player wins the grand final, a second match decides it, since the
   * winners-bracket player hadn't lost yet. "single": one grand final decides it.
   */
  grandFinal?: "reset" | "single";
};

/** Where a slot's player comes from: a seed, or the winner or loser of an earlier match. */
type Source = { seed: number } | { winnerOf: string } | { loserOf: string };
type Node = { key: string; round: number; section?: "losers" | "grand_final"; sources: [Source, Source] };
/** Who actually arrives through a source once byes are taken out: a known player, or a real match's result. */
type Producer = { player: string } | { match: string; as: "winner" | "loser" };

/**
 * Builds a double-elimination bracket. `players` are in seed order, the first being seed 1.
 *
 * The full bracket for the next power of 2 is laid out first. Then byes are taken out: a match
 * with only one player coming is not played, and that player goes on to where its winner would
 * have gone. So there are no bye matches in either bracket, and n players play 2n - 2 matches,
 * plus the reset if it is needed.
 *
 * Losers drop into the losers bracket in reversed order every other round (standard crossover),
 * so a dropped player doesn't meet the one they just lost to again straight away.
 */
export function buildDoubleElimination(players: string[], options: DoubleEliminationOptions = {}): BracketMatch[] {
  checkPlayers(players);
  const grandFinal = options.grandFinal ?? "reset";
  if (grandFinal !== "reset" && grandFinal !== "single") throw new BracketError("The grand final is either a reset or a single match.");

  const size = 2 ** Math.ceil(Math.log2(players.length));
  const k = Math.log2(size);
  const seeds = seedOrder(size);
  const wb = (round: number, i: number) => `R${round}-${i + 1}`;
  const lb = (round: number, i: number) => `L${round}-${i + 1}`;
  const nodes = (count: number, make: (i: number) => Node) => Array.from({ length: count }, (_, i) => make(i));

  const winners: Node[][] = [];
  for (let r = 1; r <= k; r++) {
    winners.push(
      nodes(size / 2 ** r, (i) => ({
        key: wb(r, i),
        round: r,
        sources:
          r === 1
            ? [{ seed: seeds[2 * i] }, { seed: seeds[2 * i + 1] }]
            : [{ winnerOf: wb(r - 1, 2 * i) }, { winnerOf: wb(r - 1, 2 * i + 1) }],
      })),
    );
  }

  // Losers round 1 pairs the losers of winners round 1. After that, even rounds take the losers of
  // the next winners round, and odd rounds halve the field.
  const losers: Node[][] = [];
  for (let j = 1; j <= 2 * k - 2; j++) {
    const section = "losers" as const;
    if (j === 1) {
      losers.push(nodes(size / 4, (i) => ({ key: lb(j, i), round: j, section, sources: [{ loserOf: wb(1, 2 * i) }, { loserOf: wb(1, 2 * i + 1) }] })));
    } else if (j % 2 === 0) {
      const r = j / 2 + 1;
      const count = size / 2 ** r;
      losers.push(
        nodes(count, (i) => ({
          key: lb(j, i),
          round: j,
          section,
          sources: [{ winnerOf: lb(j - 1, i) }, { loserOf: wb(r, r % 2 === 0 ? count - 1 - i : i) }],
        })),
      );
    } else {
      losers.push(
        nodes(losers[j - 2].length / 2, (i) => ({
          key: lb(j, i),
          round: j,
          section,
          sources: [{ winnerOf: lb(j - 1, 2 * i) }, { winnerOf: lb(j - 1, 2 * i + 1) }],
        })),
      );
    }
  }

  const grandFinalNode: Node = {
    key: "GF1",
    round: k + 1,
    section: "grand_final",
    // With 2 players there is no losers bracket: the loser of the only match goes to the grand final.
    sources: [{ winnerOf: wb(k, 0) }, k > 1 ? { winnerOf: lb(2 * k - 2, 0) } : { loserOf: wb(1, 0) }],
  };

  // Each winners round is followed by the losers rounds it feeds, so drops wait as little as possible.
  const ordered = [...winners[0]];
  for (let r = 2; r <= k; r++) ordered.push(...winners[r - 1], ...losers[2 * r - 4], ...losers[2 * r - 3]);
  ordered.push(grandFinalNode);

  const real = new Map<string, BracketMatch>();
  const produced = new Map<string, { winner: Producer | null; loser: Producer | null }>();
  const resolve = (source: Source): Producer | null => {
    if ("seed" in source) {
      const player = players[source.seed - 1];
      return player ? { player } : null;
    }
    if ("winnerOf" in source) return produced.get(source.winnerOf)!.winner;
    return produced.get(source.loserOf)!.loser;
  };
  const connect = (from: Producer, to: SlotRef) => {
    if ("player" in from) {
      const target = real.get(to.match)!;
      if (to.slot === 1) target.player1 = from.player;
      else target.player2 = from.player;
    } else if (from.as === "winner") real.get(from.match)!.winnerTo = to;
    else real.get(from.match)!.loserTo = to;
  };

  for (const node of ordered) {
    const [a, b] = node.sources.map(resolve);
    if (a && b) {
      real.set(node.key, blank(node.key, node.round, node.section));
      connect(a, { match: node.key, slot: 1 });
      connect(b, { match: node.key, slot: 2 });
      produced.set(node.key, { winner: { match: node.key, as: "winner" }, loser: { match: node.key, as: "loser" } });
    } else {
      // Not played: whoever comes through goes on as its winner, and there is no loser.
      produced.set(node.key, { winner: a ?? b, loser: null });
    }
  }

  const matches = [...real.values()];
  if (grandFinal === "reset") {
    const reset = { ...blank("GF2", k + 2, "grand_final"), ifNeeded: true };
    // The winners-bracket player stays player 1 in the reset.
    const first = real.get("GF1")!;
    first.winnerTo = { match: "GF2", slot: 2 as Slot };
    first.loserTo = { match: "GF2", slot: 1 as Slot };
    matches.push(reset);
  }
  return matches.map((m, i) => ({ ...m, playOrder: i + 1 }));
}

function blank(key: string, round: number, section?: "losers" | "grand_final"): BracketMatch {
  return {
    key,
    round,
    playOrder: 0,
    thirdPlace: false,
    ...(section && { section }),
    player1: null,
    player2: null,
    winner: null,
    winnerTo: null,
    loserTo: null,
  };
}
