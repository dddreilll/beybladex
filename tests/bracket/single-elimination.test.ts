import { describe, expect, it } from "vitest";
import { champion, correctWinner, openMatches, recordWinner } from "@/lib/bracket/progress";
import { buildSingleElimination, seedOrder } from "@/lib/bracket/single-elimination";
import { BracketError, type BracketMatch } from "@/lib/bracket/types";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const pair = (m: BracketMatch) => `${m.key}:${m.player1 ?? "-"}v${m.player2 ?? "-"}`;

/** Plays every open match until none is left, the better seed (lower number) always winning. */
function playOut(matches: BracketMatch[]): BracketMatch[] {
  let open = openMatches(matches);
  while (open.length) {
    const m = open[0];
    const better = Number(m.player1!.slice(1)) < Number(m.player2!.slice(1)) ? m.player1! : m.player2!;
    matches = recordWinner(matches, m.key, better);
    open = openMatches(matches);
  }
  return matches;
}

describe("seedOrder", () => {
  it("keeps the top seeds apart until the late rounds", () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe("buildSingleElimination", () => {
  it("pairs a full bracket of 8 by seed, and links each match to the next round", () => {
    const matches = buildSingleElimination(players(8));
    expect(matches.map(pair)).toEqual([
      "R1-1:p1vp8",
      "R1-2:p4vp5",
      "R1-3:p2vp7",
      "R1-4:p3vp6",
      "R2-1:-v-",
      "R2-2:-v-",
      "R3-1:-v-",
    ]);
    expect(matches.map((m) => m.identifier)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(matches[1].winnerTo).toEqual({ match: "R2-1", slot: 2 });
    expect(matches.at(-1)!.winnerTo).toBeNull();
  });

  it("has no bye matches: the top seeds of 6 start in round 2", () => {
    expect(buildSingleElimination(players(6)).map(pair)).toEqual(["R1-2:p4vp5", "R1-4:p3vp6", "R2-1:p1v-", "R2-2:p2v-", "R3-1:-v-"]);
  });

  it("can start a round-2 match at once when both its players had byes", () => {
    const matches = buildSingleElimination(players(5));
    expect(openMatches(matches).map(pair)).toEqual(["R1-2:p4vp5", "R2-2:p2vp3"]);
  });

  it("is a single match for 2 players", () => {
    expect(buildSingleElimination(players(2)).map(pair)).toEqual(["R1-1:p1vp2"]);
  });

  it("puts the third-place match before the final and sends the semi-final losers to it", () => {
    let matches = buildSingleElimination(players(4), { thirdPlace: true });
    expect(matches.map((m) => `${m.identifier}:${m.key}`)).toEqual(["A:R1-1", "B:R1-2", "3P:3P", "C:R2-1"]);
    matches = playOut(matches);
    const byKey = Object.fromEntries(matches.map((m) => [m.key, m]));
    expect(byKey["3P"]).toMatchObject({ player1: "p4", player2: "p3", winner: "p3", thirdPlace: true });
    expect(byKey["R2-1"]).toMatchObject({ player1: "p1", player2: "p2", winner: "p1" });
  });

  it("refuses a third-place match with fewer than 4 players, and bad player lists", () => {
    expect(() => buildSingleElimination(players(3), { thirdPlace: true })).toThrow(BracketError);
    expect(() => buildSingleElimination(["p1"])).toThrow(BracketError);
    expect(() => buildSingleElimination(["p1", "p2", "p1"])).toThrow(BracketError);
    expect(() => buildSingleElimination(["p1", ""])).toThrow(BracketError);
  });

  for (let n = 2; n <= 33; n++) {
    for (const thirdPlace of n >= 4 ? [false, true] : [false]) {
      it(`plays out ${n} players${thirdPlace ? " with a third-place match" : ""} to one champion`, () => {
        const built = buildSingleElimination(players(n), { thirdPlace });
        expect(built).toHaveLength(n - 1 + (thirdPlace ? 1 : 0));
        expect(built.map((m) => m.playOrder)).toEqual(built.map((_, i) => i + 1));

        // Every player starts somewhere, exactly once.
        const placed = built.flatMap((m) => [m.player1, m.player2]).filter(Boolean);
        expect(new Set(placed).size).toBe(n);
        expect(placed).toHaveLength(n);

        // Every empty slot is fed by exactly one match, and every link points at an empty slot.
        const fed = built.flatMap((m) => [m.winnerTo, m.loserTo]).filter(Boolean).map((to) => `${to!.match}/${to!.slot}`);
        const empty = built.flatMap((m) => [m.player1 ? null : `${m.key}/1`, m.player2 ? null : `${m.key}/2`]).filter(Boolean);
        expect(fed.sort()).toEqual(empty.sort());

        // A match is played only after the matches that feed it.
        const order = new Map(built.map((m) => [m.key, m.playOrder]));
        for (const m of built) for (const to of [m.winnerTo, m.loserTo]) if (to) expect(order.get(to.match)!).toBeGreaterThan(m.playOrder);

        const done = playOut(built);
        expect(done.every((m) => m.winner)).toBe(true);
        const final = done.find((m) => !m.winnerTo && !m.thirdPlace)!;
        expect(final.winner).toBe("p1");
        expect([final.player1, final.player2].sort()).toEqual(["p1", "p2"]);
        if (thirdPlace) expect(done.find((m) => m.thirdPlace)!.winner).toBe("p3");
      });
    }
  }
});

describe("recordWinner", () => {
  it("moves the winner on and leaves the matches passed in unchanged", () => {
    const built = buildSingleElimination(players(4));
    const after = recordWinner(built, "R1-1", "p4");
    expect(after.find((m) => m.key === "R2-1")!.player1).toBe("p4");
    expect(built.find((m) => m.key === "R2-1")!.player1).toBeNull();
  });

  it("corrects a semi-final: erases the final and the third-place match, and swaps who goes where", () => {
    const done = playOut(buildSingleElimination(players(4), { thirdPlace: true }));
    const { matches, erased } = correctWinner(done, "R1-2", "p3");
    expect(erased).toEqual(["3P", "R2-1"]);
    expect(matches.find((m) => m.key === "R2-1")).toMatchObject({ player1: "p1", player2: "p3", winner: null });
    expect(matches.find((m) => m.key === "3P")).toMatchObject({ player1: "p4", player2: "p2", winner: null });
    expect(champion(matches)).toBeNull();
    expect(champion(playOut(matches))).toBe("p1");
  });

  it("refuses a match that is decided, unknown, waiting for a player, or a winner who isn't in it", () => {
    const built = recordWinner(buildSingleElimination(players(4)), "R1-1", "p1");
    expect(() => recordWinner(built, "R1-1", "p4")).toThrow(/already has a winner/);
    expect(() => recordWinner(built, "R9-9", "p1")).toThrow(/no match/);
    expect(() => recordWinner(built, "R2-1", "p1")).toThrow(/both players/);
    expect(() => recordWinner(built, "R1-2", "p1")).toThrow(/isn't in match/);
  });
});
