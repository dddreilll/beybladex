import { describe, expect, it } from "vitest";
import { buildRoundRobin } from "@/lib/bracket/round-robin";
import { BracketError, identifierFor } from "@/lib/bracket/types";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

describe("buildRoundRobin", () => {
  it("schedules 4 players in 3 rounds of 2", () => {
    expect(buildRoundRobin(players(4)).map((m) => `${m.identifier} R${m.round} ${m.player1}v${m.player2}`)).toEqual([
      "A R1 p1vp4",
      "B R1 p2vp3",
      "C R2 p3vp1",
      "D R2 p4vp2",
      "E R3 p1vp2",
      "F R3 p3vp4",
    ]);
  });

  it("sits one player out each round when the count is odd, without a match for it", () => {
    const matches = buildRoundRobin(players(3));
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.round)).toEqual([1, 2, 3]);
  });

  it("plays the second leg after the first, with the sides swapped", () => {
    const once = buildRoundRobin(players(4));
    const twice = buildRoundRobin(players(4), { legs: 2 });
    expect(twice).toHaveLength(12);
    expect(twice.slice(6).map((m) => [m.round, m.player1, m.player2])).toEqual(once.map((m) => [m.round + 3, m.player2, m.player1]));
  });

  it("links nothing: no round robin match leads to another", () => {
    expect(buildRoundRobin(players(5)).every((m) => !m.winnerTo && !m.loserTo && !m.thirdPlace)).toBe(true);
  });

  it("refuses bad player lists and a leg count other than 1 or 2", () => {
    expect(() => buildRoundRobin(["p1"])).toThrow(BracketError);
    expect(() => buildRoundRobin(["p1", "p1"])).toThrow(BracketError);
    expect(() => buildRoundRobin(players(4), { legs: 3 as 1 })).toThrow(BracketError);
  });

  for (let n = 2; n <= 17; n++) {
    for (const legs of [1, 2] as const) {
      it(`meets every pair ${legs === 1 ? "once" : "twice"} with ${n} players`, () => {
        const matches = buildRoundRobin(players(n), { legs });
        const roundsPerLeg = n % 2 ? n : n - 1;
        expect(matches).toHaveLength(((n * (n - 1)) / 2) * legs);
        expect(Math.max(...matches.map((m) => m.round))).toBe(roundsPerLeg * legs);
        expect(matches.map((m) => m.playOrder)).toEqual(matches.map((_, i) => i + 1));

        const meetings = new Map<string, number>();
        for (const m of matches) {
          const key = [m.player1, m.player2].sort().join("|");
          meetings.set(key, (meetings.get(key) ?? 0) + 1);
        }
        expect(meetings.size).toBe((n * (n - 1)) / 2);
        expect([...meetings.values()].every((count) => count === legs)).toBe(true);

        // Nobody plays twice in a round.
        for (let r = 1; r <= roundsPerLeg * legs; r++) {
          const inRound = matches.filter((m) => m.round === r).flatMap((m) => [m.player1, m.player2]);
          expect(new Set(inRound).size).toBe(inRound.length);
        }

        // Sides come out even: each player is player 1 within one match of half the time.
        for (const p of players(n)) {
          const first = matches.filter((m) => m.player1 === p).length;
          const second = matches.filter((m) => m.player2 === p).length;
          expect(Math.abs(first - second)).toBeLessThanOrEqual(legs === 1 ? 1 : 0);
        }
      });
    }
  }
});

describe("identifierFor", () => {
  it("goes A to Z, then AA, AB, as Challonge does", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(identifierFor)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
});
