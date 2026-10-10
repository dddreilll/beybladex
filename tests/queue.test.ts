import { describe, expect, it } from "vitest";
import { planQueue, type QueueMatch, type QueueStadium } from "@/lib/queue";

const stadium = (id: string, position: number, active = true): QueueStadium => ({ id, position, active });
const match = (id: string, playOrder: number, players: [string | null, string | null], extra: Partial<QueueMatch> = {}): QueueMatch => ({
  id,
  state: "open",
  player1: players[0],
  player2: players[1],
  playOrder,
  stadiumId: null,
  callStatus: "none",
  held: false,
  ...extra,
});

const S = [stadium("s1", 1), stadium("s2", 2)];

describe("planQueue", () => {
  it("calls one match per stadium and puts the next ones on deck, in play order", () => {
    const matches = [match("C", 3, ["e", "f"]), match("A", 1, ["a", "b"]), match("B", 2, ["c", "d"]), match("D", 4, ["g", "h"]), match("E", 5, ["i", "j"])];
    expect(planQueue(S, matches, { autoCall: true, autoOnDeck: true })).toEqual([
      { matchId: "A", stadiumId: "s1", callStatus: "called" },
      { matchId: "B", stadiumId: "s1", callStatus: "on_deck" },
      { matchId: "C", stadiumId: "s2", callStatus: "called" },
      { matchId: "D", stadiumId: "s2", callStatus: "on_deck" },
    ]);
  });

  it("without auto-call only fills on deck", () => {
    expect(planQueue(S, [match("A", 1, ["a", "b"]), match("B", 2, ["c", "d"])], { autoCall: false, autoOnDeck: true })).toEqual([
      { matchId: "A", stadiumId: "s1", callStatus: "on_deck" },
      { matchId: "B", stadiumId: "s2", callStatus: "on_deck" },
    ]);
  });

  it("promotes the on-deck match when the stadium frees up, and refills on deck", () => {
    const matches = [
      match("A", 1, ["a", "b"], { state: "complete", stadiumId: "s1", callStatus: "playing" }),
      match("B", 2, ["c", "d"], { stadiumId: "s1", callStatus: "on_deck" }),
      match("C", 3, ["e", "f"]),
    ];
    expect(planQueue([stadium("s1", 1)], matches, { autoCall: true, autoOnDeck: true })).toEqual([
      { matchId: "A", stadiumId: null, callStatus: "none" },
      { matchId: "B", stadiumId: "s1", callStatus: "called" },
      { matchId: "C", stadiumId: "s1", callStatus: "on_deck" },
    ]);
  });

  it("leaves a stable queue unchanged", () => {
    const matches = [
      match("A", 1, ["a", "b"], { stadiumId: "s1", callStatus: "playing" }),
      match("B", 2, ["c", "d"], { stadiumId: "s1", callStatus: "on_deck" }),
    ];
    expect(planQueue([stadium("s1", 1)], matches, { autoCall: true, autoOnDeck: true })).toEqual([]);
  });

  it("never assigns a player who is already busy (round robin)", () => {
    const matches = [
      match("A", 1, ["a", "b"], { stadiumId: "s1", callStatus: "playing" }),
      match("B", 2, ["a", "c"]), // a is playing
      match("C", 3, ["d", "e"]),
    ];
    expect(planQueue([stadium("s1", 1)], matches, { autoCall: true, autoOnDeck: true })).toEqual([{ matchId: "C", stadiumId: "s1", callStatus: "on_deck" }]);
  });

  it("skips held matches and pulls a held on-deck match back out", () => {
    const matches = [
      match("A", 1, ["a", "b"], { held: true, stadiumId: "s1", callStatus: "on_deck" }),
      match("B", 2, ["c", "d"], { held: true }),
      match("C", 3, ["e", "f"]),
    ];
    expect(planQueue([stadium("s1", 1)], matches, { autoCall: false, autoOnDeck: true })).toEqual([
      { matchId: "A", stadiumId: null, callStatus: "none" },
      { matchId: "C", stadiumId: "s1", callStatus: "on_deck" },
    ]);
  });

  it("releases matches from a removed stadium and ignores matches without both players", () => {
    const matches = [
      match("A", 1, ["a", "b"], { stadiumId: "s2", callStatus: "called" }),
      match("I", 2, ["a", null], { state: "pending" }),
    ];
    expect(planQueue([stadium("s1", 1), stadium("s2", 2, false)], matches, { autoCall: true, autoOnDeck: true })).toEqual([
      { matchId: "A", stadiumId: "s1", callStatus: "called" },
    ]);
  });

  it("with on-deck filling off, never pulls from the queue but still calls what the organizer placed", () => {
    const empty = [match("A", 1, ["a", "b"]), match("B", 2, ["c", "d"])];
    expect(planQueue(S, empty, { autoCall: true, autoOnDeck: false })).toEqual([]);

    const placed = [match("A", 1, ["a", "b"], { stadiumId: "s1", callStatus: "on_deck" }), match("B", 2, ["c", "d"])];
    expect(planQueue(S, placed, { autoCall: true, autoOnDeck: false })).toEqual([{ matchId: "A", stadiumId: "s1", callStatus: "called" }]);
    expect(planQueue(S, placed, { autoCall: false, autoOnDeck: false })).toEqual([]);
  });

  it("a match sent back to the queue is skipped for that pass, then eligible again", () => {
    const matches = [
      match("X", 1, ["a", "b"], { stadiumId: "s1", callStatus: "playing" }),
      match("A", 2, ["c", "d"]), // just sent back from on deck
      match("B", 3, ["e", "f"]),
    ];
    const one = [stadium("s1", 1)];
    expect(planQueue(one, matches, { autoCall: true, autoOnDeck: true, skip: ["A"] })).toEqual([
      { matchId: "B", stadiumId: "s1", callStatus: "on_deck" },
    ]);
    // Next time a slot opens, A is first in play order again.
    expect(planQueue(one, matches, { autoCall: true, autoOnDeck: true })).toEqual([{ matchId: "A", stadiumId: "s1", callStatus: "on_deck" }]);
  });

  it("leaves the slot empty when the skipped match was the only one ready", () => {
    const matches = [match("X", 1, ["a", "b"], { stadiumId: "s1", callStatus: "playing" }), match("A", 2, ["c", "d"])];
    expect(planQueue([stadium("s1", 1)], matches, { autoCall: true, autoOnDeck: true, skip: ["A"] })).toEqual([]);
  });

  it("releases a match that was reset to pending by a correction", () => {
    const matches = [match("I", 1, ["a", null], { state: "pending", stadiumId: "s1", callStatus: "called" })];
    expect(planQueue([stadium("s1", 1)], matches, { autoCall: true, autoOnDeck: true })).toEqual([{ matchId: "I", stadiumId: null, callStatus: "none" }]);
  });
});
