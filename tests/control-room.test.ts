import { describe, expect, it } from "vitest";
import { mapMatch, mapParticipant } from "@/lib/challonge/map";
import type { ListResponse, MatchResource, ParticipantResource } from "@/lib/challonge/types";
import { buildControlRoom } from "@/lib/control-room";
import matchesFixture from "./fixtures/challonge/matches-started.json";
import participantsFixture from "./fixtures/challonge/participants.json";

const participants = (participantsFixture as unknown as ListResponse<ParticipantResource>).data.map(mapParticipant);
const matchRows = (matchesFixture as unknown as ListResponse<MatchResource>).data.map((m, i) => ({
  id: `local-${i}`,
  ...mapMatch(m),
}));

describe("buildControlRoom", () => {
  it("lists the 8 opening matches in suggested play order with player names", () => {
    const room = buildControlRoom("double elimination", participants, matchRows);
    expect(room.ready.map((m) => m.identifier)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect(room.ready[0]).toMatchObject({ roundLabel: "Winners R1", player1: "Blader 01", player2: "Blader 16" });
    expect(room.waiting).toEqual([]);
    expect(room.totals).toEqual({ matches: 31, completed: 0 });
  });

  it("moves a reported match to completed and shows the advanced player waiting", () => {
    // Mirrors spike S4: A reported 5–2, winner placed in I, loser in R.
    const rows = matchRows.map((m) => {
      if (m.identifier === "A") return { ...m, state: "complete", winnerChallongeId: m.player1ChallongeId, scores: "5 - 2" };
      if (m.identifier === "I") return { ...m, player1ChallongeId: "306531079" };
      if (m.identifier === "R") return { ...m, player1ChallongeId: "306531094" };
      return m;
    });
    const room = buildControlRoom("double elimination", participants, rows);
    expect(room.completed[0]).toMatchObject({ identifier: "A", winner: "Blader 01", winnerSlot: 1, scores: "5 - 2" });
    expect(room.waiting.map((m) => [m.identifier, m.roundLabel, m.player1, m.player2])).toEqual([
      ["R", "Losers R1", "Blader 16", "TBD"],
      ["I", "Winners R2", "Blader 01", "TBD"],
    ]);
  });

  it("labels the second Grand Finals match as the reset", () => {
    const room = buildControlRoom(
      "double elimination",
      participants,
      matchRows.map((m) => (m.round === 5 ? { ...m, state: "complete" } : m)),
    );
    expect(room.completed.filter((m) => m.roundLabel.startsWith("Grand")).map((m) => [m.identifier, m.roundLabel])).toEqual([
      ["Q", "Grand Finals reset"],
      ["P", "Grand Finals"],
    ]);
  });

  it("names the groups of a two-stage tournament and keeps the Grand Finals for its final stage", () => {
    // Two groups of round robin whose third round is no final, then a 4-player double elimination bracket.
    const row = (id: string, stage: "group" | "final", groupNumber: number | null, round: number, order: number) => ({
      ...matchRows[0],
      id,
      identifier: id.slice(-1),
      stage,
      groupNumber,
      round,
      suggestedPlayOrder: order,
      state: "complete",
    });
    const rows = [
      row("g1-A", "group", 1, 1, 1), row("g2-A", "group", 2, 1, 1), row("g1-C", "group", 1, 3, 3), row("g2-C", "group", 2, 3, 3),
      row("f-A", "final", null, 1, 1), row("f-F", "final", null, 3, 6), row("f-G", "final", null, 3, 7),
    ];
    const room = buildControlRoom({ tournamentType: "double elimination", groupStageType: "round robin" }, participants, rows);
    expect(Object.fromEntries(room.completed.map((m) => [m.id, m.roundLabel]))).toEqual({
      "g1-A": "Group A · Round 1",
      "g2-A": "Group B · Round 1",
      "g1-C": "Group A · Round 3",
      "g2-C": "Group B · Round 3",
      "f-A": "Winners R1",
      "f-F": "Grand Finals",
      "f-G": "Grand Finals reset",
    });
  });

  it("names each consolation match of a single elimination bracket", () => {
    // The matches of a real 8-player bracket with matches down to 7th place (spike S15), all played.
    const bracket: [string, number][] = [
      ["A", 1], ["B", 1], ["C", 1], ["D", 1], ["E", 2], ["F", 2], ["G", 3],
      ["5PQ1", 0], ["5PQ2", 0], ["5P", 0], ["7P", 0], ["3P", 0],
    ];
    const rows = bracket.map(([identifier, round], i) => ({
      ...matchRows[0],
      id: `consolation-${i}`,
      identifier,
      round,
      suggestedPlayOrder: i + 1,
      state: "complete",
    }));
    const room = buildControlRoom("single elimination", participants, rows);
    expect(room.completed.map((m) => `${m.identifier}: ${m.roundLabel}`).reverse()).toEqual([
      "A: Round 1", "B: Round 1", "C: Round 1", "D: Round 1", "E: Round 2", "F: Round 2", "G: Final",
      "5PQ1: Fifth place qualifier", "5PQ2: Fifth place qualifier", "5P: Fifth place", "7P: Seventh place", "3P: Third place",
    ]);
  });
});
