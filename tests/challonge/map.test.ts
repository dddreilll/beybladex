import { describe, expect, it } from "vitest";
import { finalStageRounds, groupLabel, mapMatch, mapParticipant, mapTournament, playersOf, roundContext, roundLabel, roundLabeller } from "@/lib/challonge/map";
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

  it("gives a round robin no final: its last round is a round like the others", () => {
    // The rounds of a real 4-player round robin (spike S7).
    const roundRobin = roundContext("round robin", [1, 1, 2, 2, 3, 3]);
    expect(roundLabel(1, roundRobin, "A")).toBe("Round 1");
    expect(roundLabel(3, roundRobin, "F")).toBe("Round 3");
  });

  it("falls back to a general label for a round 0 match it can't place", () => {
    const single = roundContext("single elimination", [1, 2, 0]);
    expect(roundLabel(0, single)).toBe("Placement match");
    expect(roundLabel(0, single, "9P")).toBe("Placement match");
    expect(roundLabel(0, single, "X")).toBe("Placement match");
  });
});

describe("roundLabeller", () => {
  // The rounds of a real two-stage tournament (spike S17): two round robin groups of 3, then a bracket of 4.
  const group = (groupNumber: number | null) => [1, 2, 3].map((round) => ({ round, stage: "group" as const, groupNumber, identifier: "ABC"[round - 1] }));
  const final = [1, 1, 2].map((round, i) => ({ round, stage: "final" as const, groupNumber: null, identifier: "ABC"[i] }));
  const all = [...group(1), ...group(2), ...final];
  const twoStage = { tournamentType: "single elimination", groupStageType: "round robin" };

  it("names a group match with its group, and gives each stage its own rounds", () => {
    const labelOf = roundLabeller(twoStage, all);
    expect(all.map(labelOf)).toEqual([
      "Group A · Round 1", "Group A · Round 2", "Group A · Round 3",
      "Group B · Round 1", "Group B · Round 2", "Group B · Round 3",
      "Round 1", "Round 1", "Final",
    ]);
  });

  it("calls no round of the groups a final, even before the final stage exists", () => {
    const labelOf = roundLabeller(twoStage, [...group(1), ...group(2)]);
    expect(labelOf(group(1)[2])).toBe("Group A · Round 3");
  });

  it("says only Group stage when the groups couldn't be told apart", () => {
    expect(roundLabeller(twoStage, group(null))(group(null)[0])).toBe("Group stage · Round 1");
  });

  it("labels the final stage as a double elimination bracket when it is one", () => {
    const bracket = [1, 1, -1, 2, -2, 3, 3].map((round) => ({ round, stage: "final" as const }));
    const labelOf = roundLabeller({ tournamentType: "double elimination", groupStageType: "swiss" }, [...group(1), ...bracket]);
    expect(bracket.map(labelOf)).toEqual(["Winners R1", "Winners R1", "Losers R1", "Winners Final", "Losers Final", "Grand Finals", "Grand Finals"]);
  });

  it("labels a tournament with one stage as before", () => {
    const labelOf = roundLabeller({ tournamentType: "double elimination" }, matches.map((m) => ({ round: m.attributes.round })));
    expect(labelOf({ round: 5 })).toBe("Grand Finals");
    expect(labelOf({ round: -1 })).toBe("Losers R1");
    expect(roundLabeller({ tournamentType: "round robin" }, [{ round: 1 }, { round: 3 }])({ round: 3, identifier: "F" })).toBe("Round 3");
  });
});

describe("groupLabel and finalStageRounds", () => {
  it("letters the groups", () => {
    expect([1, 2, 26, 27, null, 0].map(groupLabel)).toEqual(["Group A", "Group B", "Group Z", "Group 27", "Group stage", "Group stage"]);
  });

  it("leaves the rounds of the groups out of the final stage's", () => {
    expect(finalStageRounds([{ round: 3, stage: "group" }, { round: 1, stage: "final" }, { round: 2 }])).toEqual([1, 2]);
  });
});
