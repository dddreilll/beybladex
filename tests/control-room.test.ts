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
});
