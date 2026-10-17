import { describe, expect, it } from "vitest";
import { buildDoubleElimination } from "@/lib/bracket/double-elimination";
import { correctWinner, recordWinner } from "@/lib/bracket/progress";
import { buildSingleElimination } from "@/lib/bracket/single-elimination";
import { pairSwissRound } from "@/lib/bracket/swiss";
import { buildStage, swissRoundDue } from "@/lib/tournament/build";
import { formatName, isElimination, isSwiss, stagePhase } from "@/lib/tournament/format";
import { groupLabel, roundLabeller } from "@/lib/tournament/labels";
import { changes, prefixKeys, stateOf, toBracket, toRow } from "@/lib/tournament/store";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const options = { grandFinal: "reset" as const, thirdPlace: false, roundRobinLegs: 1 };

describe("format", () => {
  it("knows the formats, in either spelling", () => {
    expect(["single_elimination", "double elimination", "round_robin", "swiss"].map(isElimination)).toEqual([true, true, false, false]);
    expect(isSwiss("swiss")).toBe(true);
    expect(formatName("double_elimination")).toBe("Double elimination");
  });

  it("says where a two-stage tournament is", () => {
    const at = (state: string) => stagePhase({ groupStage: true, state });
    expect(["pending", "group_stage", "between_stages", "underway", "complete"].map(at)).toEqual([null, "groups", "between", "final", "final"]);
    expect(stagePhase({ groupStage: false, state: "underway" })).toBeNull();
  });
});

describe("store", () => {
  it("keeps a match through a row and back", () => {
    for (const m of buildDoubleElimination(players(6))) {
      const row = toRow(m, { tournamentId: "t", stage: "final", groupNumber: null });
      expect(toBracket(row)).toEqual(m);
      expect(row.state).toBe(stateOf(m));
    }
  });

  it("tells open, pending and complete matches apart", () => {
    expect(stateOf({ player1: "a", player2: "b", winner: null })).toBe("open");
    expect(stateOf({ player1: "a", player2: null, winner: null })).toBe("pending");
    expect(stateOf({ player1: "a", player2: "b", winner: "a" })).toBe("complete");
  });

  it("prefixes a group's keys, links included", () => {
    const [first] = prefixKeys(buildSingleElimination(players(4)), "G2:");
    expect(first).toMatchObject({ key: "G2:R1-1", winnerTo: { match: "G2:R2-1", slot: 1 } });
  });

  it("lists what a result changed, and which matches lost a player", () => {
    const before = recordWinner(recordWinner(buildSingleElimination(players(4)), "R1-1", "p1"), "R1-2", "p2");
    const played = recordWinner(before, "R2-1", "p1");
    expect(changes(before, played)).toEqual([{ key: "R2-1", player1Id: "p1", player2Id: "p2", winnerId: "p1", state: "complete", lostPlayer: false }]);
    const corrected = correctWinner(played, "R1-1", "p4").matches;
    expect(changes(played, corrected)).toEqual([
      { key: "R1-1", player1Id: "p1", player2Id: "p4", winnerId: "p4", state: "complete", lostPlayer: false },
      { key: "R2-1", player1Id: "p4", player2Id: "p2", winnerId: null, state: "open", lostPlayer: true },
    ]);
  });
});

describe("buildStage", () => {
  it("builds each format, and a Swiss's first round only", () => {
    expect(buildStage("single_elimination", players(8), options)).toHaveLength(7);
    expect(buildStage("single_elimination", players(8), { ...options, thirdPlace: true })).toHaveLength(8);
    // A third-place match needs 4 players; with 3 it is left out rather than refused.
    expect(buildStage("single_elimination", players(3), { ...options, thirdPlace: true })).toHaveLength(2);
    expect(buildStage("double_elimination", players(8), options)).toHaveLength(15);
    expect(buildStage("double_elimination", players(8), { ...options, grandFinal: "single" })).toHaveLength(14);
    expect(buildStage("round_robin", players(4), { ...options, roundRobinLegs: 2 })).toHaveLength(12);
    expect(buildStage("swiss", players(8), options).map((m) => m.round)).toEqual([1, 1, 1, 1]);
  });

  it("says when a Swiss round is played out and rounds remain", () => {
    const first = pairSwissRound(players(4), []);
    expect(swissRoundDue(first, 2)).toBe(false);
    const played = recordWinner(recordWinner(first, "R1-1", "p1"), "R1-2", "p2");
    expect(swissRoundDue(played, 2)).toBe(true);
    expect(swissRoundDue(played, 1)).toBe(false);
  });
});

describe("roundLabeller", () => {
  it("names a single elimination's rounds, final and third-place match", () => {
    const matches = buildSingleElimination(players(8), { thirdPlace: true });
    const labelOf = roundLabeller({ tournamentType: "single_elimination" }, matches);
    expect(matches.map(labelOf)).toEqual(["Round 1", "Round 1", "Round 1", "Round 1", "Round 2", "Round 2", "Third place", "Final"]);
    // Two players have one match, which is no final.
    expect(buildSingleElimination(players(2)).map(roundLabeller({ tournamentType: "single_elimination" }, buildSingleElimination(players(2))))).toEqual(["Round 1"]);
  });

  it("names both sides of a double elimination and its grand finals", () => {
    const matches = buildDoubleElimination(players(4));
    const labelOf = roundLabeller({ tournamentType: "double_elimination" }, matches);
    expect(matches.map(labelOf)).toEqual(["Winners R1", "Winners R1", "Winners Final", "Losers R1", "Losers Final", "Grand Finals", "Grand Finals reset"]);
  });

  it("names a group's rounds with its group, and the final stage's rounds on their own", () => {
    const group = buildSingleElimination(players(4)).map((m) => ({ ...m, stage: "group" as const, groupNumber: 2 }));
    const final = buildSingleElimination(players(4)).map((m) => ({ ...m, stage: "final" as const }));
    const labelOf = roundLabeller({ tournamentType: "single_elimination", groupStageType: "round_robin" }, [...group, ...final]);
    expect(labelOf(group[2])).toBe("Group B · Round 2");
    expect(labelOf(final[2])).toBe("Final");
    expect(groupLabel(null)).toBe("Group stage");
  });
});
