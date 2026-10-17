import { describe, expect, it } from "vitest";
import { namesProblem, parsePlayerNames, setupProblems, type Setup } from "@/lib/tournament/setup";

const setup = (extra: Partial<Setup> = {}): Setup => ({
  format: "single_elimination",
  players: 8,
  thirdPlace: false,
  swissRounds: null,
  groupStage: null,
  ...extra,
});

describe("parsePlayerNames", () => {
  it("splits on commas and new lines, trims, and drops blanks", () => {
    expect(parsePlayerNames("Alex, Sam\nRiley\r\n\n  Jordan  ,, ")).toEqual(["Alex", "Sam", "Riley", "Jordan"]);
    expect(parsePlayerNames("  Mary   Jane ")).toEqual(["Mary Jane"]);
    expect(parsePlayerNames(" , \n ")).toEqual([]);
  });
});

describe("namesProblem", () => {
  it("accepts new names, and refuses none, doubles in any case, and names too long", () => {
    expect(namesProblem(["Alex", "Sam"])).toBeNull();
    expect(namesProblem([])).toBe("Type at least one name.");
    expect(namesProblem(["Alex", "alex"])).toBe("alex is in the list twice.");
    expect(namesProblem(["Sam"], ["Alex", "SAM"])).toBe("Sam is in the list twice.");
    expect(namesProblem(["x".repeat(61)])).toMatch(/longer than 60 characters/);
  });

  it("refuses more than 256 players", () => {
    const many = Array.from({ length: 257 }, (_, i) => `P${i}`);
    expect(namesProblem(many)).toBe("A tournament has at most 256 players.");
  });
});

describe("setupProblems", () => {
  it("is ready with enough players and options that fit", () => {
    expect(setupProblems(setup())).toEqual([]);
    expect(setupProblems(setup({ format: "swiss", swissRounds: 3 }))).toEqual([]);
    expect(setupProblems(setup({ thirdPlace: true }))).toEqual([]);
  });

  it("needs 2 players to start, but not to be created", () => {
    expect(setupProblems(setup({ players: 1 }))).toEqual(["A tournament needs at least 2 players."]);
    expect(setupProblems(setup({ players: null }))).toEqual([]);
  });

  it("checks the groups against the players", () => {
    const groups = (players: number | null, g: number, advance: number) => setupProblems(setup({ players, groupStage: { groups: g, advance } }));
    expect(groups(8, 2, 2)).toEqual([]);
    expect(groups(5, 3, 1)).toEqual(["3 groups need at least 6 players."]);
    expect(groups(8, 2, 4)).toEqual(["With groups of 4, fewer than 4 per group can go through."]);
    expect(groups(8, 1, 1)).toEqual(["A group stage needs at least 2 groups.", "At least 2 players must go through to the final stage."]);
    expect(groups(null, 2, 0)).toEqual(["At least 1 player per group goes through."]);
    // Before the players are in, the groups are only checked against each other.
    expect(groups(null, 2, 4)).toEqual([]);
  });

  it("allows a third-place match only in single elimination with 4 players in the final stage", () => {
    expect(setupProblems(setup({ format: "double_elimination", thirdPlace: true }))).toEqual(["Only single elimination has a third-place match."]);
    expect(setupProblems(setup({ players: 3, thirdPlace: true }))).toEqual(["A third-place match needs at least 4 players in the final stage."]);
    expect(setupProblems(setup({ players: null, thirdPlace: true, groupStage: { groups: 3, advance: 1 } }))).toEqual([
      "A third-place match needs at least 4 players in the final stage.",
    ]);
    expect(setupProblems(setup({ players: null, thirdPlace: true }))).toEqual([]);
  });

  it("refuses more Swiss rounds than the final stage's players can play", () => {
    expect(setupProblems(setup({ format: "swiss", players: 4, swissRounds: 4 }))).toEqual(["4 players can play at most 3 Swiss rounds."]);
    expect(setupProblems(setup({ format: "swiss", players: null, swissRounds: 9 }))).toEqual([]);
  });
});
