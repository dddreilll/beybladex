import { describe, expect, it } from "vitest";
import type { BoardMatch, BoardSnapshot } from "@/lib/board";
import { endGroupStageBlockers, finalizeBlockers } from "@/lib/finalize-check";
import { ordinal } from "@/lib/format";
import { playerStatus } from "@/lib/player-status";

const match = (id: string, p1: string, p2: string | null, status: BoardMatch["status"] = "none", extra: Partial<BoardMatch> = {}): BoardMatch => ({
  id,
  label: `Winners R1 · ${id}`,
  round: "Winners R1",
  matchName: `Match ${id}`,
  player1: { id: p1, name: `Player ${p1}` },
  player2: p2 ? { id: p2, name: `Player ${p2}` } : null,
  status,
  liveScore: null,
  lastBattle: null,
  calledAt: null,
  callNumber: status === "called" ? 1 : 0,
  ...extra,
});

const board = (overrides: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  version: 7,
  tournament: { name: "Autumn Clash", state: "underway" },
  currentRound: "Winners R1",
  stadiums: [
    { id: "s1", name: "Stadium 1", now: match("A", "1", "2", "called", { callNumber: 2 }), next: match("B", "3", "4", "on_deck") },
    { id: "s2", name: "Stadium 2", now: match("C", "5", "6", "playing", { liveScore: "2–1", lastBattle: "Player 5 · Xtreme +3" }), next: null },
  ],
  queue: [match("D", "7", "8"), match("E", "9", "10")],
  waiting: [match("I", "11", null)],
  standings: null,
  tables: [],
  ...overrides,
});

describe("playerStatus", () => {
  it("tells a called player their stadium, opponent and call number", () => {
    expect(playerStatus(board(), "2")).toEqual({
      kind: "called",
      stadium: "Stadium 1",
      match: { opponent: "Player 1", label: "Winners R1 · A", callNumber: 2, liveScore: null },
    });
  });

  it("shows the live score to a player who is playing", () => {
    expect(playerStatus(board(), "5")).toMatchObject({ kind: "playing", stadium: "Stadium 2", match: { opponent: "Player 6", liveScore: "2–1" } });
  });

  it("covers on deck, queued (with position), waiting and idle", () => {
    expect(playerStatus(board(), "4")).toMatchObject({ kind: "on_deck", stadium: "Stadium 1", match: { opponent: "Player 3" } });
    expect(playerStatus(board(), "7")).toMatchObject({ kind: "queued", position: 1 });
    expect(playerStatus(board(), "10")).toMatchObject({ kind: "queued", position: 2, match: { opponent: "Player 9" } });
    expect(playerStatus(board(), "11")).toMatchObject({ kind: "waiting", match: { opponent: "TBD" } });
    expect(playerStatus(board(), "99")).toEqual({ kind: "idle" });
  });

  it("carries nothing about other players' matches", () => {
    const text = JSON.stringify(playerStatus(board(), "2"));
    for (const other of ["Player 3", "Player 5", "Player 7", "Stadium 2", "Xtreme"]) expect(text).not.toContain(other);
  });

  it("switches to the placement once the tournament is finalized", () => {
    const finished = board({
      standings: [
        { id: "1", name: "Player 1", rank: 1 },
        { id: "2", name: "Player 2", rank: 2 },
      ],
    });
    expect(playerStatus(finished, "2")).toEqual({ kind: "finished", rank: 2, of: 2 });
    // Someone Challonge gave no placement still gets the "finished" screen, not a stale match.
    expect(playerStatus(finished, "9")).toEqual({ kind: "finished", rank: null, of: 2 });
  });

  it("tells a player with no match whether they went on from the group stage", () => {
    const between = board({ tournament: { name: "Autumn Clash", state: "between_stages" }, stadiums: [], queue: [], waiting: [] });
    expect(playerStatus(between, "1", true)).toEqual({ kind: "advanced" });
    expect(playerStatus(between, "1", false)).toEqual({ kind: "out" });
    expect(playerStatus(between, "1", null)).toEqual({ kind: "idle" });
    // Once the final stage is being played, someone who advanced and has no match was knocked out of it.
    expect(playerStatus(board(), "99", true)).toEqual({ kind: "idle" });
    expect(playerStatus(board(), "99", false)).toEqual({ kind: "out" });
  });

  it("shows a match before anything about the group stage, and the placement at the end", () => {
    expect(playerStatus(board(), "2", true)).toMatchObject({ kind: "called" });
    const finished = board({ standings: [{ id: "2", name: "Player 2", rank: 5 }] });
    expect(playerStatus(finished, "2", false)).toEqual({ kind: "finished", rank: 5, of: 1 });
  });
});

describe("ordinal", () => {
  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [102, "102nd"],
    [113, "113th"],
  ])("%i is %s", (n, text) => {
    expect(ordinal(n)).toBe(text);
  });
});

describe("finalizeBlockers", () => {
  const states = (...list: string[]) => list.map((state) => ({ state, round: 1 }));
  /** Matches as [state, round]. */
  const rounds = (...list: [string, number][]) => list.map(([state, round]) => ({ state, round }));

  it("is ready when nothing is open", () => {
    expect(finalizeBlockers({ matches: states("complete", "complete") })).toEqual([]);
  });

  it("counts the matches still to play", () => {
    expect(finalizeBlockers({ matches: states("complete", "open", "open", "pending") })).toEqual(["2 matches still to play."]);
    expect(finalizeBlockers({ matches: states("complete", "open") })).toEqual(["1 match still to play."]);
  });

  it("doesn't wait for a grand-final reset that wasn't needed, which never opens", () => {
    expect(finalizeBlockers({ matches: states("complete", "complete", "pending") })).toEqual([]);
  });

  it("waits for the rounds of a Swiss tournament that aren't paired yet", () => {
    const afterRoundTwo = rounds(["complete", 1], ["complete", 1], ["complete", 2], ["complete", 2]);
    expect(finalizeBlockers({ matches: afterRoundTwo, swissRounds: 3 })).toEqual(["Round 3 of 3 isn't paired yet."]);
    expect(finalizeBlockers({ matches: afterRoundTwo, swissRounds: 2 })).toEqual([]);
    // With a round still being played, the open matches are what is said.
    expect(finalizeBlockers({ matches: [...afterRoundTwo, { state: "open", round: 3 }], swissRounds: 5 })).toEqual(["1 match still to play."]);
    // Other formats have no such count.
    expect(finalizeBlockers({ matches: afterRoundTwo, swissRounds: null })).toEqual([]);
  });

  it("waits for a two-stage tournament to reach its final stage", () => {
    const played = states("complete", "complete");
    expect(finalizeBlockers({ matches: played, phase: "groups" })).toEqual(["The group stage is still being played."]);
    expect(finalizeBlockers({ matches: played, phase: "between" })).toEqual(["The final stage hasn't started yet."]);
    expect(finalizeBlockers({ matches: played, phase: "final" })).toEqual([]);
    expect(finalizeBlockers({ matches: states("complete", "open"), phase: "final" })).toEqual(["1 match still to play."]);
    expect(finalizeBlockers({ matches: played, phase: null })).toEqual([]);
  });

  it("counts a Swiss final stage's own rounds, not the groups'", () => {
    // Round robin groups of 4 played 3 rounds; the Swiss final stage has played its first of 2.
    const groups = [1, 2, 3].map((round) => ({ state: "complete", round, stage: "group" as const }));
    const firstRound = [{ state: "complete", round: 1, stage: "final" as const }];
    expect(finalizeBlockers({ matches: [...groups, ...firstRound], swissRounds: 2, phase: "final" })).toEqual(["Round 2 of 2 isn't paired yet."]);
    expect(finalizeBlockers({ matches: [...groups, ...firstRound, { state: "complete", round: 2, stage: "final" }], swissRounds: 2, phase: "final" })).toEqual([]);
    // A final stage just started: its matches are what is still to play.
    expect(finalizeBlockers({ matches: [...groups, { state: "open", round: 1, stage: "final" }], phase: "final" })).toEqual(["1 match still to play."]);
  });

  it("refuses a tournament with no results", () => {
    expect(finalizeBlockers({ matches: [] })).toEqual(["No match has been played yet."]);
    expect(finalizeBlockers({ matches: states("pending", "pending") })).toEqual(["No match has been played yet."]);
  });
});

describe("endGroupStageBlockers", () => {
  const states = (...list: string[]) => list.map((state) => ({ state }));

  it("is ready when every group match is played", () => {
    expect(endGroupStageBlockers({ matches: states("complete", "complete") })).toEqual([]);
  });

  it("says what is left to play", () => {
    expect(endGroupStageBlockers({ matches: states("open", "open") })).toEqual(["No match has been played yet."]);
    expect(endGroupStageBlockers({ matches: [] })).toEqual(["No match has been played yet."]);
    expect(endGroupStageBlockers({ matches: states("complete", "open", "open") })).toEqual(["2 matches still to play."]);
  });
});
