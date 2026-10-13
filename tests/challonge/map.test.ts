import { describe, expect, it } from "vitest";
import { mapMatch, mapParticipant, mapTournament, playersOf, roundContext, roundLabel } from "@/lib/challonge/map";
import type { ListResponse, MatchResource, ParticipantResource, SingleResponse, TournamentResource } from "@/lib/challonge/types";
import matchesFixture from "../fixtures/challonge/matches-started.json";
import participantsFixture from "../fixtures/challonge/participants.json";
import tournamentFixture from "../fixtures/challonge/tournament.json";

// Recorded from a real 16-player double-elimination bracket right after it started (spike S2).
const matches = (matchesFixture as unknown as ListResponse<MatchResource>).data;
const participants = (participantsFixture as unknown as ListResponse<ParticipantResource>).data;
const tournament = (tournamentFixture as unknown as SingleResponse<TournamentResource>).data;

describe("playersOf", () => {
  it("reads players from points_by_participant, not relationships", () => {
    const first = matches.find((m) => m.attributes.identifier === "A")!;
    expect(first.relationships).not.toHaveProperty("player1");
    expect(playersOf(first)).toEqual(["306531079", "306531094"]);
  });

  it("returns null for slots not filled yet", () => {
    const later = matches.find((m) => m.attributes.identifier === "I")!;
    expect(playersOf(later)).toEqual([null, null]);
  });
});

describe("mappers", () => {
  it("maps the tournament", () => {
    expect(mapTournament(tournament)).toMatchObject({
      challongeId: "18602864",
      tournamentType: "double elimination",
      participantsCount: 16,
      groupStage: false,
    });
  });

  it("maps every participant", () => {
    const mapped = participants.map(mapParticipant);
    expect(mapped).toHaveLength(16);
    expect(mapped[0]).toEqual({ challongeId: "306531079", name: "Blader 01", seed: 1, active: true, finalRank: null });
  });

  it("reads a participant's final placement once Challonge has set it", () => {
    const [first] = participants;
    expect(mapParticipant({ ...first, attributes: { ...first.attributes, final_rank: 3 } }).finalRank).toBe(3);
  });

  it("maps matches with string ids and parsed dates", () => {
    const open = mapMatch(matches.find((m) => m.attributes.identifier === "A")!);
    expect(open).toMatchObject({
      identifier: "A",
      round: 1,
      state: "open",
      suggestedPlayOrder: 1,
      player1ChallongeId: "306531079",
      player2ChallongeId: "306531094",
      winnerChallongeId: null,
      underwayAt: null,
    });
  });
});

describe("roundLabel", () => {
  const ctx = roundContext("double elimination", matches.map((m) => m.attributes.round));

  it("labels winners, losers and finals rounds", () => {
    expect(ctx).toMatchObject({ maxRound: 5, minRound: -6 });
    expect(roundLabel(1, ctx)).toBe("Winners R1");
    expect(roundLabel(4, ctx)).toBe("Winners Final");
    expect(roundLabel(5, ctx)).toBe("Grand Finals");
    expect(roundLabel(-1, ctx)).toBe("Losers R1");
    expect(roundLabel(-6, ctx)).toBe("Losers Final");
  });

  it("labels single elimination rounds", () => {
    const single = roundContext("single elimination", [1, 2, 3]);
    expect(roundLabel(2, single)).toBe("Round 2");
    expect(roundLabel(3, single)).toBe("Final");
  });

  it("labels the consolation matches, which Challonge all puts in round 0, by their identifier", () => {
    // The rounds of a real 8-player single elimination bracket with matches down to 7th place (spikes S6, S15).
    const single = roundContext("single elimination", [1, 1, 1, 1, 2, 2, 3, 0, 0, 0, 0, 0]);
    expect(single).toMatchObject({ maxRound: 3, minRound: 0 });
    expect(roundLabel(0, single, "3P")).toBe("Third place");
    expect(roundLabel(0, single, "5P")).toBe("Fifth place");
    expect(roundLabel(0, single, "7P")).toBe("Seventh place");
    expect(roundLabel(0, single, "5PQ1")).toBe("Fifth place qualifier");
    expect(roundLabel(0, single, "5PQ2")).toBe("Fifth place qualifier");
    expect(roundLabel(3, single, "G")).toBe("Final");
    expect(roundLabel(1, single, "A")).toBe("Round 1");
  });

  it("falls back to a general label for a round 0 match it can't place", () => {
    const single = roundContext("single elimination", [1, 2, 0]);
    expect(roundLabel(0, single)).toBe("Placement match");
    expect(roundLabel(0, single, "9P")).toBe("Placement match");
    expect(roundLabel(0, single, "X")).toBe("Placement match");
  });
});
