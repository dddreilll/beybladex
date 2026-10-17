import { describe, expect, it } from "vitest";
import { recordWinner } from "@/lib/bracket/progress";
import { maxSwissRounds, pairSwissRound, suggestedSwissRounds, swissFirstRoundPairs } from "@/lib/bracket/swiss";
import { BracketError, type BracketMatch } from "@/lib/bracket/types";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const pair = (m: BracketMatch) => (m.bye ? `bye:${m.player1}` : `${m.player1}v${m.player2}`);

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pairs and plays `rounds` rounds; `pick` chooses each winner. */
function playSwiss(list: string[], rounds: number, pick: (m: BracketMatch) => string): BracketMatch[] {
  let played: BracketMatch[] = [];
  for (let r = 0; r < rounds; r++) {
    let round = pairSwissRound(list, played);
    for (const m of round.filter((m) => !m.bye)) round = recordWinner(round, m.key, pick(m));
    played = [...played, ...round];
  }
  return played;
}

describe("suggestedSwissRounds", () => {
  it("suggests enough rounds to leave one player unbeaten", () => {
    expect([2, 3, 4, 8, 9, 16, 17, 32, 33].map(suggestedSwissRounds)).toEqual([1, 2, 2, 3, 4, 4, 5, 5, 6]);
    expect(maxSwissRounds(8)).toBe(7);
    expect(maxSwissRounds(7)).toBe(7);
    expect(() => suggestedSwissRounds(1)).toThrow(BracketError);
  });
});

describe("pairSwissRound", () => {
  it("pairs round 1 top half against bottom half", () => {
    expect(pairSwissRound(players(8), []).map(pair)).toEqual(["p1vp5", "p2vp6", "p3vp7", "p4vp8"]);
    expect(swissFirstRoundPairs(8)).toEqual([[1, 5], [2, 6], [3, 7], [4, 8]]);
  });

  it("gives the round-1 bye to the last seed, as a win, and names only real matches", () => {
    const round = pairSwissRound(players(5), []);
    expect(round.map(pair)).toEqual(["p1vp3", "p2vp4", "bye:p5"]);
    expect(round.at(-1)).toMatchObject({ winner: "p5", identifier: "Bye", player2: null });
    expect(round.map((m) => m.identifier)).toEqual(["A", "B", "Bye"]);
  });

  it("pairs later rounds within each group on the same wins, top half against bottom half", () => {
    const first = playSwiss(players(8), 1, (m) => m.player1!);
    const second = pairSwissRound(players(8), first);
    // Winners p1-p4 (top half p1, p2 against bottom half p3, p4), then losers p5-p8.
    expect(second.map(pair)).toEqual(["p1vp3", "p2vp4", "p5vp7", "p6vp8"]);
    expect(second.map((m) => m.identifier)).toEqual(["E", "F", "G", "H"]);
    expect(second.map((m) => m.playOrder)).toEqual([5, 6, 7, 8]);
  });

  it("doesn't give anyone a second bye", () => {
    const played = playSwiss(players(5), 5, (m) => m.player1!);
    const byes = played.filter((m) => m.bye).map((m) => m.player1);
    expect(new Set(byes).size).toBe(5);
  });

  it("refuses a round that isn't finished, and a round past the last possible one", () => {
    expect(() => pairSwissRound(players(4), pairSwissRound(players(4), []))).toThrow(/isn't finished/);
    expect(() => pairSwissRound(players(4), playSwiss(players(4), 3, (m) => m.player1!))).toThrow(/already met/);
  });

  it("goes on without a player who dropped out, whose matches stay played", () => {
    const played = playSwiss(players(6), 1, (m) => m.player1!);
    const next = pairSwissRound(players(6).filter((p) => p !== "p4"), played);
    expect(next.flatMap((m) => [m.player1, m.player2])).not.toContain("p4");
    expect(next.filter((m) => m.bye)).toHaveLength(1);
  });

  for (let n = 2; n <= 40; n++) {
    it(`pairs ${n} players for the suggested rounds without a rematch`, () => {
      for (let seed = 1; seed <= 3; seed++) {
        const rand = random(n * 10 + seed);
        const rounds = suggestedSwissRounds(n);
        const played = playSwiss(players(n), rounds, (m) => (rand() < 0.5 ? m.player1! : m.player2!));
        const real = played.filter((m) => !m.bye);
        const meetings = real.map((m) => [m.player1, m.player2].sort().join("|"));
        expect(new Set(meetings).size).toBe(meetings.length);
        for (let r = 1; r <= rounds; r++) {
          const inRound = played.filter((m) => m.round === r).flatMap((m) => [m.player1, m.player2]).filter(Boolean);
          expect(inRound.sort()).toEqual(players(n).sort());
        }
        const byes = played.filter((m) => m.bye).map((m) => m.player1);
        expect(new Set(byes).size).toBe(byes.length);
      }
    });
  }

  for (const n of [4, 6, 8, 10]) {
    it(`with ${n} players, can play every round there is (every pair meets once) when the winners are by seed`, () => {
      const played = playSwiss(players(n), maxSwissRounds(n), (m) => (Number(m.player1!.slice(1)) < Number(m.player2!.slice(1)) ? m.player1! : m.player2!));
      const meetings = played.map((m) => [m.player1, m.player2].sort().join("|"));
      expect(new Set(meetings).size).toBe((n * (n - 1)) / 2);
    });
  }
});
