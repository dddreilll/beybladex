import { describe, expect, it } from "vitest";
import { buildDoubleElimination } from "@/lib/bracket/double-elimination";
import { champion, openMatches, recordWinner } from "@/lib/bracket/progress";
import { buildRoundRobin } from "@/lib/bracket/round-robin";
import { buildSingleElimination, seedOrder } from "@/lib/bracket/single-elimination";
import { placements } from "@/lib/bracket/standings";
import { pairSwissRound, swissFirstRoundPairs } from "@/lib/bracket/swiss";
import { rankGroup, seedFinalStage, splitIntoGroups } from "@/lib/bracket/two-stage";
import { BracketError, type BracketMatch, type Format } from "@/lib/bracket/types";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const seedOf = (p: string) => Number(p.slice(1));
const better = (m: BracketMatch) => (seedOf(m.player1!) < seedOf(m.player2!) ? m.player1! : m.player2!);

function playOut(matches: BracketMatch[]) {
  let open = openMatches(matches);
  while (open.length) {
    matches = recordWinner(matches, open[0].key, better(open[0]));
    open = openMatches(matches);
  }
  return matches;
}

/** Each group's players named by group and place: A1, A2, … B1, B2, … */
const rankedGroups = (groups: number, size: number) =>
  Array.from({ length: groups }, (_, g) => Array.from({ length: size }, (_, i) => `${String.fromCharCode(65 + g)}${i + 1}`));

function firstRound(format: Format, n: number): [number, number][] {
  if (format === "swiss") return swissFirstRoundPairs(n);
  const order = seedOrder(2 ** Math.ceil(Math.log2(n)));
  const pairs: [number, number][] = [];
  for (let i = 0; i < order.length; i += 2) if (order[i] <= n && order[i + 1] <= n) pairs.push([order[i], order[i + 1]]);
  return pairs;
}

describe("splitIntoGroups", () => {
  it("snakes the seeds through the groups", () => {
    expect(splitIntoGroups(players(8), 2)).toEqual([
      ["p1", "p4", "p5", "p8"],
      ["p2", "p3", "p6", "p7"],
    ]);
    expect(splitIntoGroups(players(10), 3)).toEqual([
      ["p1", "p6", "p7"],
      ["p2", "p5", "p8"],
      ["p3", "p4", "p9", "p10"],
    ]);
  });

  it("refuses fewer than 2 groups, and groups of fewer than 2", () => {
    expect(() => splitIntoGroups(players(8), 1)).toThrow(BracketError);
    expect(() => splitIntoGroups(players(5), 3)).toThrow(BracketError);
  });
});

describe("seedFinalStage", () => {
  it("seeds every group winner first, then the runners-up", () => {
    expect(seedFinalStage(rankedGroups(2, 4), 2, "single_elimination")).toEqual(["A1", "B1", "A2", "B2"]);
  });

  it("swaps within a tier so a group's players don't meet in round 1", () => {
    // Swiss pairs 1 v 3 and 2 v 4, so A1, B1, A2, B2 would pair A1 with A2.
    expect(seedFinalStage(rankedGroups(2, 4), 2, "swiss")).toEqual(["A1", "B1", "B2", "A2"]);
  });

  it("refuses too few groups, and more going through than a group has", () => {
    expect(() => seedFinalStage(rankedGroups(1, 4), 2, "single_elimination")).toThrow(BracketError);
    expect(() => seedFinalStage(rankedGroups(2, 2), 2, "single_elimination")).toThrow(BracketError);
    expect(() => seedFinalStage(rankedGroups(2, 4), 0, "single_elimination")).toThrow(BracketError);
  });

  for (const format of ["single_elimination", "double_elimination", "swiss"] as const) {
    for (let groups = 2; groups <= 8; groups++) {
      for (let perGroup = 1; perGroup <= 4; perGroup++) {
        it(`keeps groups apart in round 1: ${groups} groups, top ${perGroup}, ${format.replace("_", " ")}`, () => {
          const ranked = rankedGroups(groups, perGroup + 1);
          const order = seedFinalStage(ranked, perGroup, format);
          // The tiers stay: seeds 1 to G are the group winners, and so on.
          for (let tier = 0; tier < perGroup; tier++) {
            expect(order.slice(tier * groups, (tier + 1) * groups).sort()).toEqual(ranked.map((g) => g[tier]).sort());
          }
          const clashes = firstRound(format, order.length).filter(([a, b]) => order[a - 1][0] === order[b - 1][0]);
          expect(clashes).toEqual([]);
        });
      }
    }
  }
});

describe("a two-stage tournament", () => {
  it("plays round robin groups, then a single-elimination final stage of the top 2 of each", () => {
    const groups = splitIntoGroups(players(16), 4);
    const ranked = groups.map((group) => rankGroup("round_robin", group, playOut(buildRoundRobin(group))));
    expect(ranked.map((g) => g.slice(0, 2))).toEqual([
      ["p1", "p8"],
      ["p2", "p7"],
      ["p3", "p6"],
      ["p4", "p5"],
    ]);
    const finalists = seedFinalStage(ranked, 2, "single_elimination");
    const final = playOut(buildSingleElimination(finalists));
    expect(champion(final)).toBe("p1");
    expect(placements("single_elimination", finalists, final).slice(0, 2)).toEqual([
      { player: "p1", place: 1 },
      { player: "p2", place: 2 },
    ]);
  });

  it("ranks a group that is a bracket by place, a shared place by seed", () => {
    const group = players(4);
    expect(rankGroup("double_elimination", group, playOut(buildDoubleElimination(group)))).toEqual(["p1", "p2", "p3", "p4"]);
    expect(rankGroup("single_elimination", group, playOut(buildSingleElimination(group)))).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("ranks a Swiss group by its standings", () => {
    const group = players(4);
    let played: BracketMatch[] = [];
    for (let r = 0; r < 2; r++) played = [...played, ...playOut(pairSwissRound(group, played))];
    expect(rankGroup("swiss", group, played)[0]).toBe("p1");
  });
});
