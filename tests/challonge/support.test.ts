import { describe, expect, it } from "vitest";
import { mapTournament, previewTournament } from "@/lib/challonge/map";
import { formatOptions, formatSupport } from "@/lib/challonge/support";
import type { SingleResponse, TournamentAttributes, TournamentResource } from "@/lib/challonge/types";
import tournamentFixture from "../fixtures/challonge/tournament.json";

// Recorded from a real 16-player double-elimination bracket (spike S2).
const recorded = (tournamentFixture as unknown as SingleResponse<TournamentResource>).data;
const withAttributes = (attributes: Partial<TournamentAttributes>): TournamentResource => ({
  ...recorded,
  attributes: { ...recorded.attributes, ...attributes },
});

describe("formatSupport", () => {
  const reasonFor = (tournamentType: string, groupStage = false) => {
    const support = formatSupport({ tournamentType, groupStage });
    return support.supported ? null : support.reason;
  };

  it("runs single and double elimination", () => {
    expect(formatSupport({ tournamentType: "single elimination", groupStage: false })).toEqual({ supported: true });
    expect(formatSupport({ tournamentType: "double elimination", groupStage: false })).toEqual({ supported: true });
    expect(formatSupport(mapTournament(recorded))).toEqual({ supported: true });
  });

  it("reads the type whatever its case or separators", () => {
    expect(reasonFor("Double Elimination")).toBeNull();
    expect(reasonFor("single_elimination")).toBeNull();
    expect(reasonFor(" Round Robin ")).toMatch(/round robin/);
  });

  it("refuses round robin and Swiss, which haven't been run against Challonge", () => {
    expect(reasonFor("round robin")).toBe("BXQ doesn't run round robin tournaments yet. It runs single and double elimination.");
    expect(reasonFor("swiss")).toBe("BXQ doesn't run Swiss tournaments yet. It runs single and double elimination.");
  });

  it("refuses free for all, whose matches have more than two players", () => {
    expect(reasonFor("free for all")).toBe("BXQ can't run free-for-all tournaments: its matches are one player against one.");
  });

  it("refuses a type it doesn't know", () => {
    expect(reasonFor("leaderboard")).toBe("BXQ doesn't run this format (leaderboard) yet. It runs single and double elimination.");
    expect(reasonFor("")).toBe("BXQ doesn't run this format yet. It runs single and double elimination.");
  });

  it("refuses a group stage in front of an elimination bracket", () => {
    expect(reasonFor("single elimination", true)).toBe("BXQ doesn't run two-stage tournaments yet (a group stage, then a final stage).");
    expect(reasonFor("double elimination", true)).toMatch(/two-stage/);
    // The type is the first thing wrong with it.
    expect(reasonFor("round robin", true)).toMatch(/round robin/);
  });
});

describe("mapTournament", () => {
  it("reads the group stage, off when Challonge doesn't say", () => {
    expect(mapTournament(recorded).groupStage).toBe(false);
    expect(mapTournament(withAttributes({ group_stage_enabled: true })).groupStage).toBe(true);
    expect(mapTournament(withAttributes({ group_stage_enabled: undefined })).groupStage).toBe(false);
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
      grandFinals: "reset",
      thirdPlaceMatch: false,
    });
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

describe("formatOptions", () => {
  it("shows the grand finals of a double elimination bracket", () => {
    const options = (grandFinals: "reset" | "single" | "skip") =>
      formatOptions({ tournamentType: "double elimination", grandFinals, thirdPlaceMatch: false });
    expect(options("reset")).toEqual([{ label: "Grand finals", value: "1 or 2 matches (a reset if the losers-side finalist wins the first)" }]);
    expect(options("single")).toEqual([{ label: "Grand finals", value: "1 match, no reset" }]);
    expect(options("skip")).toEqual([{ label: "Grand finals", value: "None" }]);
  });

  it("shows the third-place match of a single elimination bracket", () => {
    const options = (thirdPlaceMatch: boolean) => formatOptions({ tournamentType: "single elimination", grandFinals: null, thirdPlaceMatch });
    expect(options(true)).toEqual([{ label: "Third-place match", value: "Yes" }]);
    expect(options(false)).toEqual([{ label: "Third-place match", value: "No" }]);
  });

  it("shows nothing it wasn't told", () => {
    expect(formatOptions({ tournamentType: "double elimination", grandFinals: null, thirdPlaceMatch: null })).toEqual([]);
    expect(formatOptions({ tournamentType: "single elimination", grandFinals: "reset", thirdPlaceMatch: null })).toEqual([]);
  });
});
