import { describe, expect, it } from "vitest";
import { findResetMatches, learnProgression, type MatchSlots } from "@/lib/challonge/progression";

// Player and match ids below are the real ones observed in spikes S4 and S4b.
const P1 = "306531079";
const P2 = "306531094";
const P3 = "306531086";

const m = (challongeId: string, state: string, player1: string | null = null, player2: string | null = null): MatchSlots => ({
  challongeId,
  state,
  player1ChallongeId: player1,
  player2ChallongeId: player2,
});

describe("learnProgression", () => {
  it("finds where the winner and loser went after a first report (S4)", () => {
    const before = [m("A", "open", P1, P2), m("I", "pending"), m("R", "pending")];
    const after = [m("A", "complete", P1, P2), m("I", "pending", P1), m("R", "pending", P2)];
    expect(learnProgression(before, after, { challongeId: "A", winnerId: P1, loserId: P2 })).toEqual({
      winnerNext: "I",
      loserNext: "R",
    });
  });

  it("follows the new winner when a result is flipped (S4b)", () => {
    const before = [m("A", "complete", P1, P2), m("I", "pending", P1), m("R", "pending", P2)];
    const after = [m("A", "complete", P1, P2), m("I", "pending", P2), m("R", "pending", P1)];
    expect(learnProgression(before, after, { challongeId: "A", winnerId: P2, loserId: P1 })).toEqual({
      winnerNext: "I",
      loserNext: "R",
    });
  });

  it("returns null when a player has nowhere to go (finals)", () => {
    const before = [m("GF", "open", P1, P2)];
    const after = [m("GF", "complete", P1, P2)];
    expect(learnProgression(before, after, { challongeId: "GF", winnerId: P1, loserId: P2 })).toEqual({
      winnerNext: null,
      loserNext: null,
    });
  });
});

describe("findResetMatches", () => {
  it("detects downstream results wiped by a correction (S4b)", () => {
    const before = [m("A", "complete", P2, P1), m("I", "complete", P2, P3), m("B", "complete", P3, "x")];
    const after = [m("A", "complete", P1, P2), m("I", "open", P1, P3), m("B", "complete", P3, "x")];
    expect(findResetMatches(before, after, "A")).toEqual(["I"]);
  });

  it("treats matches that disappeared as reset", () => {
    expect(findResetMatches([m("I", "complete", P1, P3)], [], "A")).toEqual(["I"]);
  });
});
