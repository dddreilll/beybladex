import { describe, expect, it } from "vitest";
import { mapTournament, previewTournament } from "@/lib/challonge/map";
import { formatOptions, formatSupport, groupStageSummary, isElimination, isSwiss, stagePhase, stageType } from "@/lib/challonge/support";
import type { SingleResponse, TournamentAttributes, TournamentResource } from "@/lib/challonge/types";
import roundRobinFixture from "../fixtures/challonge/round-robin-tournament.json";
import swissFixture from "../fixtures/challonge/swiss-tournament.json";
import tournamentFixture from "../fixtures/challonge/tournament.json";
import twoStageDoubleFixture from "../fixtures/challonge/two-stage-double-elimination-tournament.json";
import twoStageFixture from "../fixtures/challonge/two-stage-round-robin-tournament.json";
import twoStageSingleFixture from "../fixtures/challonge/two-stage-single-elimination-tournament.json";
import twoStageSwissFixture from "../fixtures/challonge/two-stage-swiss-tournament.json";

// Recorded from a real 16-player double-elimination bracket (spike S2).
const recorded = (tournamentFixture as unknown as SingleResponse<TournamentResource>).data;
// Recorded from a real 4-player round robin right after it started (spike S7).
const roundRobin = (roundRobinFixture as unknown as SingleResponse<TournamentResource>).data;
// Recorded from a real 6-player Swiss of 3 rounds right after it started (spike S10).
const swiss = (swissFixture as unknown as SingleResponse<TournamentResource>).data;
// Recorded from real two-stage tournaments right after their group stage started (spike S17):
// 6 players in round robin groups of 3, and 8 players in Swiss groups of 4.
const twoStage = (twoStageFixture as unknown as SingleResponse<TournamentResource>).data;
const twoStageSwiss = (twoStageSwissFixture as unknown as SingleResponse<TournamentResource>).data;
// And with groups that are brackets: 8 players in single and in double elimination groups of 4.
const twoStageSingle = (twoStageSingleFixture as unknown as SingleResponse<TournamentResource>).data;
const twoStageDouble = (twoStageDoubleFixture as unknown as SingleResponse<TournamentResource>).data;
const withAttributes = (attributes: Partial<TournamentAttributes>): TournamentResource => ({
  ...recorded,
  attributes: { ...recorded.attributes, ...attributes },
});

describe("formatSupport", () => {
  const reasonFor = (tournamentType: string, groupStage = false, groupStageType: string | null = null) => {
    const support = formatSupport({ tournamentType, groupStage, groupStageType });
    return support.supported ? null : support.reason;
  };

  it("runs single elimination, double elimination, round robin and Swiss", () => {
    expect(formatSupport({ tournamentType: "swiss", groupStage: false })).toEqual({ supported: true });
    expect(formatSupport(mapTournament(swiss))).toEqual({ supported: true });
    expect(formatSupport({ tournamentType: "single elimination", groupStage: false })).toEqual({ supported: true });
    expect(formatSupport({ tournamentType: "double elimination", groupStage: false })).toEqual({ supported: true });
    expect(formatSupport({ tournamentType: "round robin", groupStage: false })).toEqual({ supported: true });
    expect(formatSupport(mapTournament(recorded))).toEqual({ supported: true });
    expect(formatSupport(mapTournament(roundRobin))).toEqual({ supported: true });
  });

  it("reads the type whatever its case or separators", () => {
    expect(reasonFor("Double Elimination")).toBeNull();
    expect(reasonFor("single_elimination")).toBeNull();
    expect(reasonFor(" Round Robin ")).toBeNull();
    expect(reasonFor(" SWISS ")).toBeNull();
    expect(reasonFor(" Free For All ")).toMatch(/free-for-all/);
  });

  it("refuses free for all, whose matches have more than two players", () => {
    expect(reasonFor("free for all")).toBe("BXQ can't run free-for-all tournaments: its matches are one player against one.");
  });

  it("refuses a type it doesn't know", () => {
    expect(reasonFor("leaderboard")).toBe("BXQ doesn't run this format (leaderboard) yet. It runs single elimination, double elimination, round robin and Swiss.");
    expect(reasonFor("")).toBe("BXQ doesn't run this format yet. It runs single elimination, double elimination, round robin and Swiss.");
  });

  it("runs a two-stage tournament with groups of any format it runs and a bracket for its final stage", () => {
    expect(reasonFor("single elimination", true, "round robin")).toBeNull();
    expect(reasonFor("double elimination", true, "swiss")).toBeNull();
    expect(reasonFor("single elimination", true, "single elimination")).toBeNull();
    expect(reasonFor("single elimination", true, "double elimination")).toBeNull();
    expect(reasonFor("Single Elimination", true, " Round Robin ")).toBeNull();
    expect(formatSupport(mapTournament(twoStage))).toEqual({ supported: true });
    expect(formatSupport(mapTournament(twoStageSwiss))).toEqual({ supported: true });
    expect(formatSupport(mapTournament(twoStageSingle))).toEqual({ supported: true });
    expect(formatSupport(mapTournament(twoStageDouble))).toEqual({ supported: true });
  });

  it("refuses groups of a format it doesn't run, and groups it knows nothing about", () => {
    expect(reasonFor("single elimination", true, "free for all")).toBe(
      "BXQ doesn't run groups of this format (free for all) yet. Its groups can be single elimination, double elimination, round robin or Swiss.",
    );
    expect(reasonFor("single elimination", true)).toBe("BXQ can't run this two-stage tournament: Challonge didn't say what its groups play.");
  });

  it("refuses a final stage that isn't a bracket", () => {
    expect(reasonFor("round robin", true, "round robin")).toBe(
      "BXQ runs a two-stage tournament only when its final stage is single or double elimination (this one's is round robin).",
    );
    expect(reasonFor("swiss", true, "swiss")).toMatch(/final stage is single or double elimination/);
    // The type is the first thing wrong with it.
    expect(reasonFor("free for all", true, "round robin")).toMatch(/free-for-all/);
  });
});

describe("isElimination and isSwiss", () => {
  it("tell the brackets, round robin and Swiss apart", () => {
    expect(isElimination("single elimination")).toBe(true);
    expect(isElimination("Double Elimination")).toBe(true);
    expect(isElimination("round robin")).toBe(false);
    expect(isElimination("swiss")).toBe(false);
    expect(isSwiss("Swiss")).toBe(true);
    expect(isSwiss("round robin")).toBe(false);
    expect(isSwiss("double elimination")).toBe(false);
  });
});

describe("stageType and stagePhase", () => {
  const format = { tournamentType: "single elimination", groupStageType: "swiss" };

  it("gives a match the format of its stage", () => {
    expect(stageType(format, "group")).toBe("swiss");
    expect(stageType(format, "final")).toBe("single elimination");
    expect(isElimination(stageType(format, "group"))).toBe(false);
    // Without a group stage there is one format.
    expect(stageType({ tournamentType: "round robin", groupStageType: null }, "group")).toBe("round robin");
  });

  it("says where a two-stage tournament is", () => {
    const phase = (state: string, groupStage = true) => stagePhase({ groupStage, state });
    expect(phase("pending")).toBe("groups");
    expect(phase("group_stages_underway")).toBe("groups");
    expect(phase("group_stages_finalized")).toBe("between");
    expect(phase("underway")).toBe("final");
    expect(phase("awaiting_review")).toBe("final");
    expect(phase("complete")).toBe("final");
    expect(phase("underway", false)).toBeNull();
    expect(phase("pending", false)).toBeNull();
  });
});

describe("mapTournament", () => {
  it("reads how many rounds a Swiss tournament has, and none for the other formats", () => {
    expect(mapTournament(swiss).swissRounds).toBe(3);
    expect(mapTournament(recorded).swissRounds).toBeNull();
    expect(mapTournament(roundRobin).swissRounds).toBeNull();
  });

  it("reads the group stage, off when Challonge doesn't say", () => {
    expect(mapTournament(recorded).groupStage).toBe(false);
    expect(mapTournament(withAttributes({ group_stage_enabled: true })).groupStage).toBe(true);
    expect(mapTournament(withAttributes({ group_stage_enabled: undefined })).groupStage).toBe(false);
  });

  it("reads what the groups of a two-stage tournament play, and how big they are", () => {
    expect(mapTournament(twoStage)).toMatchObject({ tournamentType: "single elimination", groupStage: true, groupStageType: "round robin", groupSize: 3, startedAt: null });
    expect(mapTournament(twoStageSwiss)).toMatchObject({ groupStageType: "swiss", groupSize: 4, swissRounds: null });
    expect(mapTournament(recorded)).toMatchObject({ groupStageType: null, groupSize: null });
    // Options left behind by a group stage that was switched off don't count.
    expect(mapTournament(withAttributes({ group_stage_enabled: false, group_stage_options: { stage_type: "swiss", group_size: 4 } }))).toMatchObject({
      groupStageType: null,
      groupSize: null,
    });
  });

  it("reads when the tournament started, which in a two-stage one is its final stage", () => {
    expect(mapTournament(recorded).startedAt).toEqual(new Date(recorded.attributes.timestamps!.started_at!));
    expect(mapTournament(twoStage).startedAt).toBeNull();
  });
});

describe("previewTournament", () => {
  it("previews the recorded tournament", () => {
    expect(previewTournament(recorded)).toEqual({
      challongeId: "18602864",
      challongeUrl: "xl4tobg6",
      name: "[SPIKE]",
      state: "underway",
      tournamentType: "double elimination",
      participantsCount: 16,
      groups: null,
      grandFinals: "reset",
      thirdPlaceMatch: false,
      iterations: null,
      swissRounds: null,
    });
  });

  it("previews the recorded Swiss tournament, with its number of rounds", () => {
    expect(previewTournament(swiss)).toMatchObject({ tournamentType: "swiss", participantsCount: 6, iterations: null, swissRounds: 3 });
  });

  it("previews the recorded round robin, with how often each pair meets", () => {
    expect(previewTournament(roundRobin)).toMatchObject({
      name: "[SPIKE] BXQ round robin, 4 players",
      tournamentType: "round robin",
      participantsCount: 4,
      grandFinals: null,
      iterations: 1,
    });
  });

  it("previews a two-stage tournament, with its groups", () => {
    expect(previewTournament(twoStage)).toMatchObject({
      tournamentType: "single elimination",
      participantsCount: 6,
      groups: { type: "round robin", size: 3, advance: 2 },
      thirdPlaceMatch: false,
    });
    expect(previewTournament(twoStageSwiss).groups).toEqual({ type: "swiss", size: 4, advance: 2 });
    // A list that says there are groups and not what they play.
    expect(previewTournament(withAttributes({ group_stage_enabled: true })).groups).toEqual({ type: null, size: null, advance: null });
  });

  it("reads each grand finals setting", () => {
    const grandFinals = (grand_finals_modifier: string | null) =>
      previewTournament(withAttributes({ double_elimination_options: { grand_finals_modifier } })).grandFinals;
    expect(grandFinals(null)).toBe("reset");
    expect(grandFinals("")).toBe("reset");
    expect(grandFinals("single match")).toBe("single");
    expect(grandFinals("skip")).toBe("skip");
    expect(grandFinals("something new")).toBeNull();
  });

  it("reads a third-place match from either field", () => {
    const thirdPlace = (match_options: TournamentAttributes["match_options"]) => previewTournament(withAttributes({ match_options })).thirdPlaceMatch;
    expect(thirdPlace({ consolation_matches_target_rank: 3 })).toBe(true);
    expect(thirdPlace({ consolation_matches_target_rank: null })).toBe(false);
    expect(thirdPlace({ third_place_match: true })).toBe(true);
    expect(thirdPlace({ third_place_match: false, consolation_matches_target_rank: 3 })).toBe(false);
  });

  it("leaves an option out when Challonge didn't send it", () => {
    const bare = previewTournament(withAttributes({ double_elimination_options: undefined, match_options: undefined }));
    expect(bare).toMatchObject({ grandFinals: null, thirdPlaceMatch: null });
    expect(previewTournament(withAttributes({ match_options: {} })).thirdPlaceMatch).toBeNull();
  });
});

describe("groupStageSummary", () => {
  it("says a group stage in a line", () => {
    expect(groupStageSummary({ type: "round robin", size: 4, advance: 2 })).toBe("Round robin, groups of 4, top 2 advance");
    expect(groupStageSummary({ type: "swiss", size: 8, advance: 4 })).toBe("Swiss, groups of 8, top 4 advance");
    expect(groupStageSummary(previewTournament(twoStageDouble).groups!)).toBe("Double elimination, groups of 4, top 2 advance");
    expect(groupStageSummary({ type: null, size: null, advance: null })).toBe("Groups");
  });
});

describe("formatOptions", () => {
  const nothing = { grandFinals: null, thirdPlaceMatch: null, iterations: null, swissRounds: null };

  it("shows the grand finals of a double elimination bracket", () => {
    const options = (grandFinals: "reset" | "single" | "skip") => formatOptions({ ...nothing, tournamentType: "double elimination", grandFinals });
    expect(options("reset")).toEqual([{ label: "Grand finals", value: "1 or 2 matches (a reset if the losers-side finalist wins the first)" }]);
    expect(options("single")).toEqual([{ label: "Grand finals", value: "1 match, no reset" }]);
    expect(options("skip")).toEqual([{ label: "Grand finals", value: "None" }]);
  });

  it("shows the third-place match of a single elimination bracket", () => {
    const options = (thirdPlaceMatch: boolean) => formatOptions({ ...nothing, tournamentType: "single elimination", thirdPlaceMatch });
    expect(options(true)).toEqual([{ label: "Third-place match", value: "Yes" }]);
    expect(options(false)).toEqual([{ label: "Third-place match", value: "No" }]);
  });

  it("shows how often each pair meets in a round robin", () => {
    const options = (iterations: number) => formatOptions({ ...nothing, tournamentType: "round robin", iterations });
    expect(options(1)).toEqual([{ label: "Plays each opponent", value: "Once" }]);
    expect(options(2)).toEqual([{ label: "Plays each opponent", value: "Twice" }]);
    expect(options(3)).toEqual([{ label: "Plays each opponent", value: "3 times" }]);
  });

  it("shows the number of rounds of a Swiss tournament", () => {
    expect(formatOptions({ ...nothing, tournamentType: "swiss", swissRounds: 5 })).toEqual([{ label: "Rounds", value: "5" }]);
  });

  it("shows nothing it wasn't told", () => {
    expect(formatOptions({ ...nothing, tournamentType: "double elimination" })).toEqual([]);
    expect(formatOptions({ ...nothing, tournamentType: "single elimination", grandFinals: "reset" })).toEqual([]);
    expect(formatOptions({ ...nothing, tournamentType: "round robin" })).toEqual([]);
    expect(formatOptions({ ...nothing, tournamentType: "swiss" })).toEqual([]);
  });
});
