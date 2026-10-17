import { describe, expect, it } from "vitest";
import { buildDoubleElimination } from "@/lib/bracket/double-elimination";
import { champion, openMatches, recordWinner } from "@/lib/bracket/progress";
import { buildRoundRobin } from "@/lib/bracket/round-robin";
import { buildSingleElimination } from "@/lib/bracket/single-elimination";
import { placements, standings } from "@/lib/bracket/standings";
import type { BracketMatch } from "@/lib/bracket/types";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const seedOf = (p: string) => Number(p.slice(1));
const better = (m: BracketMatch) => (seedOf(m.player1!) < seedOf(m.player2!) ? m.player1! : m.player2!);

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playOut(matches: BracketMatch[], pick = better) {
  let open = openMatches(matches);
  while (open.length) {
    matches = recordWinner(matches, open[0].key, pick(open[0]));
    open = openMatches(matches);
  }
  return matches;
}

const done = (p1: string, p2: string, winner: string, score?: [number, number]): BracketMatch => ({
  key: `${p1}-${p2}`,
  round: 1,
  playOrder: 1,
  thirdPlace: false,
  player1: p1,
  player2: p2,
  winner,
  winnerTo: null,
  loserTo: null,
  ...(score && { score }),
});
const bye = (p: string): BracketMatch => ({ ...done(p, "", p), key: `${p}-bye`, player2: null, bye: true });
const places = (list: { player: string; place: number }[]) => list.map((p) => `${p.player}:${p.place}`);

describe("standings", () => {
  it("ranks by wins, then Buchholz, then head-to-head", () => {
    // a and c are 2-1 with the same Buchholz, and a beat c. d and e have no wins; d met stronger
    // players, so d has the higher Buchholz.
    const matches = [done("a", "c", "a"), done("a", "d", "a"), done("b", "a", "b"), done("b", "d", "b"), done("c", "b", "c"), done("c", "d", "c"), done("e", "b", "b")];
    const rows = standings(["e", "d", "c", "b", "a"], matches);
    expect(rows.map((r) => `${r.player}:${r.wins}-${r.losses}:${r.buchholz}`)).toEqual(["b:3-1:4", "a:2-1:5", "c:2-1:5", "d:0-3:7", "e:0-1:3"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("breaks a tie on wins and Buchholz by head-to-head, then points difference, then seed", () => {
    const h2h = standings(["a", "b"], [done("a", "x", "a"), done("b", "y", "b"), done("b", "a", "b")].concat(done("x", "b", "x")));
    expect(h2h.map((r) => r.player)).toEqual(["b", "a"]);

    const points = standings(["a", "b"], [done("a", "x", "a", [4, 3]), done("b", "y", "b", [4, 0])]);
    expect(points.map((r) => `${r.player}:${r.pointsFor}-${r.pointsAgainst}`)).toEqual(["b:4-0", "a:4-3"]);

    expect(standings(["b", "a"], [done("a", "x", "a"), done("b", "y", "b")]).map((r) => r.player)).toEqual(["b", "a"]);
  });

  it("counts a bye as a win that adds nothing to anyone's Buchholz", () => {
    const rows = standings(["a", "b", "c"], [bye("c"), done("a", "b", "a")]);
    expect(rows.find((r) => r.player === "c")).toMatchObject({ wins: 1, losses: 0, byes: 1, buchholz: 0 });
    expect(rows.find((r) => r.player === "a")).toMatchObject({ wins: 1, buchholz: 0 });
  });
});

describe("placements", () => {
  it("shares a place between players knocked out in the same round", () => {
    expect(places(placements("single_elimination", players(8), playOut(buildSingleElimination(players(8)))))).toEqual(["p1:1", "p2:2", "p3:3", "p4:3", "p5:5", "p6:5", "p7:5", "p8:5"]);
    expect(places(placements("single_elimination", players(6), playOut(buildSingleElimination(players(6)))))).toEqual(["p1:1", "p2:2", "p3:3", "p4:3", "p5:5", "p6:5"]);
  });

  it("separates 3rd and 4th with a third-place match", () => {
    expect(places(placements("single_elimination", players(4), playOut(buildSingleElimination(players(4), { thirdPlace: true }))))).toEqual(["p1:1", "p2:2", "p3:3", "p4:4"]);
  });

  it("places double elimination by how far each player got in the losers bracket", () => {
    expect(places(placements("double_elimination", players(8), playOut(buildDoubleElimination(players(8)))))).toEqual(["p1:1", "p2:2", "p3:3", "p4:4", "p5:5", "p6:5", "p7:7", "p8:7"]);
  });

  it("makes the winners-bracket player 2nd when they lose a single grand final", () => {
    const matches = playOut(buildDoubleElimination(players(4), { grandFinal: "single" }), (m) => (m.key === "GF1" ? m.player2! : better(m)));
    expect(places(placements("double_elimination", players(4), matches)).slice(0, 2)).toEqual(["p2:1", "p1:2"]);
  });

  it("uses the standings in a round robin", () => {
    const matches = playOut(buildRoundRobin(players(4)));
    expect(places(placements("round_robin", players(4), matches))).toEqual(["p1:1", "p2:2", "p3:3", "p4:4"]);
  });

  it("refuses a stage that isn't finished", () => {
    expect(() => placements("single_elimination", players(4), buildSingleElimination(players(4)))).toThrow(/isn't finished/);
    expect(() => placements("round_robin", players(4), buildRoundRobin(players(4)))).toThrow(/isn't finished/);
  });

  for (const format of ["single_elimination", "double_elimination"] as const) {
    for (let n = 2; n <= 33; n++) {
      it(`places all ${n} players of a random ${format.replace("_", " ")}`, () => {
        const rand = random(n);
        const built = format === "single_elimination" ? buildSingleElimination(players(n)) : buildDoubleElimination(players(n));
        const matches = playOut(built, (m) => (rand() < 0.5 ? m.player1! : m.player2!));
        const list = placements(format, players(n), matches);
        expect(list).toHaveLength(n);
        expect(list[0]).toEqual({ player: champion(matches), place: 1 });
        expect(list.filter((p) => p.place === 1)).toHaveLength(1);
        expect(list.filter((p) => p.place === 2)).toHaveLength(1);
        // A place is 1 + the number of players placed above it.
        for (const p of list) expect(p.place).toBe(1 + list.filter((o) => o.place < p.place).length);
      });
    }
  }
});
