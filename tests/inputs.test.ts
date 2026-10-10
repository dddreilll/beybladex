import { describe, expect, it } from "vitest";
import { parseTournamentRef } from "@/lib/challonge/tournament-ref";
import { safeNextPath } from "@/lib/config";

describe("parseTournamentRef", () => {
  it.each([
    ["18602864", "18602864"],
    ["xl4tobg6", "xl4tobg6"],
    ["  my_bracket  ", "my_bracket"],
    ["https://challonge.com/xl4tobg6", "xl4tobg6"],
    ["https://challonge.com/en/xl4tobg6/standings", "xl4tobg6"],
    ["https://www.challonge.com/xl4tobg6", "xl4tobg6"],
  ])("accepts %s", (input, expected) => {
    expect(parseTournamentRef(input)).toBe(expected);
  });

  it.each(["", "https://evil.example/xl4tobg6", "../../me", "bad slug", "javascript:alert(1)"])("rejects %s", (input) => {
    expect(parseTournamentRef(input)).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/tournaments/abc?x=1")).toBe("/tournaments/abc?x=1");
  });

  it.each([null, "", "https://evil.example", "//evil.example", "/\\evil.example", "tournaments"])("falls back for %s", (input) => {
    expect(safeNextPath(input)).toBe("/tournaments");
  });
});
