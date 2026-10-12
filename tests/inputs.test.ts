import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTournamentRef } from "@/lib/challonge/tournament-ref";
import { contactEmail, earlyAccessUrl, operatorName, safeNextPath } from "@/lib/config";

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

describe("earlyAccessUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["https://forms.example/bxq", "https://forms.example/bxq"],
    ["  https://m.me/example  ", "https://m.me/example"],
    ["http://localhost:4000/form", "http://localhost:4000/form"],
  ])("accepts %s", (input, expected) => {
    vi.stubEnv("EARLY_ACCESS_URL", input);
    expect(earlyAccessUrl()).toBe(expected);
  });

  it.each(["", "   ", "forms.example/bxq", "javascript:alert(1)", "mailto:to@example.test", "/auth/login"])("has no link for %s", (input) => {
    vi.stubEnv("EARLY_ACCESS_URL", input);
    expect(earlyAccessUrl()).toBeNull();
  });
});

describe("operatorName and contactEmail", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("names the operator this deployment sets, trimmed", () => {
    vi.stubEnv("OPERATOR_NAME", "  Manila Bladers Club ");
    expect(operatorName()).toBe("Manila Bladers Club");
  });

  it.each(["", "   "])("has no operator name for '%s'", (input) => {
    vi.stubEnv("OPERATOR_NAME", input);
    expect(operatorName()).toBeNull();
  });

  it.each([
    ["hello@bladers.example", "hello@bladers.example"],
    ["  to+bxq@mail.example.ph ", "to+bxq@mail.example.ph"],
  ])("accepts the address %s", (input, expected) => {
    vi.stubEnv("CONTACT_EMAIL", input);
    expect(contactEmail()).toBe(expected);
  });

  it.each(["", "hello", "hello@", "@bladers.example", "hello@bladers", "a b@bladers.example", 'x"onmouseover="y@z.example', "mailto:hello@bladers.example?<x>"])(
    "has no contact for %s",
    (input) => {
      vi.stubEnv("CONTACT_EMAIL", input);
      expect(contactEmail()).toBeNull();
    },
  );
});
