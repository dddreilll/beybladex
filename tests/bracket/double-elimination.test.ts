import { describe, expect, it } from "vitest";
import { buildDoubleElimination } from "@/lib/bracket/double-elimination";
import { champion, correctWinner, openMatches, recordWinner } from "@/lib/bracket/progress";
import { BracketError, type BracketMatch } from "@/lib/bracket/types";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const seedOf = (p: string) => Number(p.slice(1));
const pair = (m: BracketMatch) => `${m.key}:${m.player1 ?? "-"}v${m.player2 ?? "-"}`;
const get = (matches: BracketMatch[], key: string) => matches.find((m) => m.key === key)!;

/** A small seeded random number generator, so a failing play-out can be replayed. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plays every open match until none is left. `pick` chooses the winner; by default the better seed. */
function playOut(matches: BracketMatch[], pick = (m: BracketMatch) => (seedOf(m.player1!) < seedOf(m.player2!) ? m.player1! : m.player2!)) {
  let open = openMatches(matches);
  while (open.length) {
    matches = recordWinner(matches, open[0].key, pick(open[0]));
    open = openMatches(matches);
  }
  return matches;
}

const losses = (matches: BracketMatch[]) => {
  const count = new Map<string, number>();
  for (const m of matches) {
    if (!m.winner) continue;
    const loser = m.winner === m.player1 ? m.player2! : m.player1!;
    count.set(loser, (count.get(loser) ?? 0) + 1);
  }
  return count;
};

/** The shape every bracket must have, whatever its size and however it was played. */
function expectWellFormed(matches: BracketMatch[]) {
  const fed = matches.flatMap((m) => [m.winnerTo, m.loserTo]).filter(Boolean).map((to) => `${to!.match}/${to!.slot}`);
  expect(new Set(fed).size).toBe(fed.length);
  const order = new Map(matches.map((m) => [m.key, m.playOrder]));
  for (const m of matches) for (const to of [m.winnerTo, m.loserTo]) if (to) expect(order.get(to.match)!).toBeGreaterThan(m.playOrder);
}

/** A finished bracket: one champion, and everyone else out after two losses (one, for a runner-up without a reset). */
function expectFinished(matches: BracketMatch[], n: number, grandFinal: "reset" | "single") {
  const winner = champion(matches);
  expect(winner).not.toBeNull();
  expect(openMatches(matches)).toEqual([]);
  const lost = losses(matches);
  expect(lost.get(winner!) ?? 0).toBeLessThanOrEqual(1);
  const others = players(n).filter((p) => p !== winner);
  const once = others.filter((p) => lost.get(p) === 1);
  expect(others.every((p) => (lost.get(p) ?? 0) >= 1 && (lost.get(p) ?? 0) <= 2)).toBe(true);
  expect(once.length).toBeLessThanOrEqual(grandFinal === "single" ? 1 : 0);
}

describe("buildDoubleElimination", () => {
  it("lays out 8 players: winners, losers with crossover, and a grand final that may reset", () => {
    const matches = buildDoubleElimination(players(8));
    expect(matches.map((m) => m.key)).toEqual(["R1-1", "R1-2", "R1-3", "R1-4", "R2-1", "R2-2", "L1-1", "L1-2", "L2-1", "L2-2", "R3-1", "L3-1", "L4-1", "GF1", "GF2"]);
    expect(matches.map((m) => m.identifier).slice(0, 3)).toEqual(["A", "B", "C"]);
    // Winners round 2 losers drop reversed: the loser of R2-2 meets the winner of L1-1.
    expect(get(matches, "R2-2").loserTo).toEqual({ match: "L2-1", slot: 2 });
    expect(get(matches, "R2-1").loserTo).toEqual({ match: "L2-2", slot: 2 });
    expect(get(matches, "GF2")).toMatchObject({ section: "grand_final", ifNeeded: true });
    expect(get(matches, "L1-1").section).toBe("losers");
  });

  it("keeps a dropped player away from the one who just beat them", () => {
    const done = playOut(buildDoubleElimination(players(8)));
    // p5 lost to p4 in round 1; p4 drops in round 2 and meets p6, not p5.
    expect(pair(get(done, "L2-1"))).toBe("L2-1:p5vp3");
    expect(pair(get(done, "L2-2"))).toBe("L2-2:p6vp4");
  });

  it("has no bye matches: 3 players play 4 matches, plus the reset", () => {
    expect(buildDoubleElimination(players(3)).map(pair)).toEqual(["R1-2:p2vp3", "R2-1:p1v-", "L2-1:-v-", "GF1:-v-", "GF2:-v-"]);
  });

  it("with 2 players, sends the loser of the only match straight to the grand final", () => {
    const matches = buildDoubleElimination(players(2), { grandFinal: "single" });
    expect(matches.map((m) => m.key)).toEqual(["R1-1", "GF1"]);
    expect(get(matches, "R1-1").loserTo).toEqual({ match: "GF1", slot: 2 });
  });

  it("plays the reset only when the losers-bracket player wins the grand final", () => {
    let matches = playOut(buildDoubleElimination(players(4)));
    expect(get(matches, "GF1").winner).toBe("p1");
    expect(get(matches, "GF2")).toMatchObject({ player1: null, player2: null, winner: null });
    expect(champion(matches)).toBe("p1");

    matches = playOut(buildDoubleElimination(players(4)), (m) => (m.key === "GF1" ? m.player2! : seedOf(m.player1!) < seedOf(m.player2!) ? m.player1! : m.player2!));
    expect(pair(get(matches, "GF2"))).toBe("GF2:p1vp2");
    expect(champion(matches)).toBe("p1");
  });

  it("with a single grand final, the losers-bracket player can win it outright", () => {
    const matches = playOut(buildDoubleElimination(players(4), { grandFinal: "single" }), (m) => (m.key === "GF1" ? m.player2! : seedOf(m.player1!) < seedOf(m.player2!) ? m.player1! : m.player2!));
    expect(matches.some((m) => m.ifNeeded)).toBe(false);
    expect(champion(matches)).toBe("p2");
  });

  it("refuses bad player lists and an unknown grand final", () => {
    expect(() => buildDoubleElimination(["p1"])).toThrow(BracketError);
    expect(() => buildDoubleElimination(["p1", "p1"])).toThrow(BracketError);
    expect(() => buildDoubleElimination(players(4), { grandFinal: "twice" as "single" })).toThrow(BracketError);
  });

  for (let n = 2; n <= 33; n++) {
    for (const grandFinal of ["reset", "single"] as const) {
      it(`builds and plays out ${n} players (${grandFinal} grand final)`, () => {
        const built = buildDoubleElimination(players(n), { grandFinal });
        expect(built).toHaveLength(2 * n - 2 + (grandFinal === "reset" ? 1 : 0));
        expect(built.map((m) => m.playOrder)).toEqual(built.map((_, i) => i + 1));
        expectWellFormed(built);

        // Every player starts somewhere, exactly once, and every empty slot is fed by one match.
        const placed = built.flatMap((m) => [m.player1, m.player2]).filter(Boolean);
        expect(new Set(placed).size).toBe(n);
        expect(placed).toHaveLength(n);
        const fed = built.flatMap((m) => [m.winnerTo, m.loserTo]).filter(Boolean).map((to) => `${to!.match}/${to!.slot}`);
        const empty = built.flatMap((m) => [m.player1 ? null : `${m.key}/1`, m.player2 ? null : `${m.key}/2`]).filter(Boolean);
        expect(fed.sort()).toEqual(empty.sort());

        const seeded = playOut(built);
        expect(champion(seeded)).toBe("p1");
        expectFinished(seeded, n, grandFinal);

        for (let seed = 1; seed <= 5; seed++) {
          const rand = random(n * 100 + seed);
          expectFinished(playOut(built, (m) => (rand() < 0.5 ? m.player1! : m.player2!)), n, grandFinal);
        }
      });
    }
  }
});

describe("correctWinner", () => {
  it("erases the later match the old winner played, and drops the old winner to the losers bracket", () => {
    let matches = buildDoubleElimination(players(4));
    matches = recordWinner(recordWinner(recordWinner(matches, "R1-1", "p1"), "R1-2", "p2"), "R2-1", "p1");
    const { matches: after, erased } = correctWinner(matches, "R1-1", "p4");
    expect(erased).toEqual(["R2-1"]);
    expect(get(after, "R2-1")).toMatchObject({ player1: "p4", player2: "p2", winner: null });
    // The old winner now drops into the losers bracket instead.
    expect(get(after, "L1-1").player1).toBe("p1");
    expect(get(after, "L2-1").player1).toBeNull();
    // The matches passed in are left alone.
    expect(get(matches, "R2-1").winner).toBe("p1");
  });

  it("erases results in both brackets, in play order", () => {
    let matches = buildDoubleElimination(players(4));
    for (const [key, winner] of [["R1-1", "p1"], ["R1-2", "p2"], ["R2-1", "p1"], ["L1-1", "p3"], ["L2-1", "p2"]] as const) matches = recordWinner(matches, key, winner);
    const { erased } = correctWinner(matches, "R1-2", "p3");
    expect(erased).toEqual(["R2-1", "L1-1", "L2-1"]);
  });

  it("opens the reset when the grand final is corrected to the losers-bracket player, and erases it when corrected back", () => {
    const done = playOut(buildDoubleElimination(players(4)));
    const toLosers = correctWinner(done, "GF1", "p2");
    expect(toLosers.erased).toEqual([]);
    expect(pair(get(toLosers.matches, "GF2"))).toBe("GF2:p1vp2");

    const resetPlayed = recordWinner(toLosers.matches, "GF2", "p2");
    expect(champion(resetPlayed)).toBe("p2");
    const back = correctWinner(resetPlayed, "GF1", "p1");
    expect(back.erased).toEqual(["GF2"]);
    expect(get(back.matches, "GF2")).toMatchObject({ player1: null, player2: null, winner: null });
    expect(champion(back.matches)).toBe("p1");
  });

  it("changes nothing when the winner is the same, and refuses a match without a winner", () => {
    const matches = recordWinner(buildDoubleElimination(players(4)), "R1-1", "p1");
    expect(correctWinner(matches, "R1-1", "p1")).toEqual({ matches, erased: [] });
    expect(() => correctWinner(matches, "R1-2", "p2")).toThrow(/no winner to correct/);
    expect(() => correctWinner(matches, "R1-1", "p2")).toThrow(/isn't in match/);
  });

  for (const n of [5, 8, 12, 16, 23]) {
    it(`leaves ${n} players in a bracket that still plays out after any correction`, () => {
      const rand = random(n);
      const built = buildDoubleElimination(players(n));
      const done = playOut(built, (m) => (rand() < 0.5 ? m.player1! : m.player2!));
      for (const m of done.filter((m) => m.winner)) {
        const other = m.winner === m.player1 ? m.player2! : m.player1!;
        const { matches: corrected, erased } = correctWinner(done, m.key, other);
        expect(erased).not.toContain(m.key);
        expect(get(corrected, m.key).winner).toBe(other);
        expectWellFormed(corrected);
        expectFinished(playOut(corrected, (x) => (rand() < 0.5 ? x.player1! : x.player2!)), n, "reset");
      }
    });
  }
});
