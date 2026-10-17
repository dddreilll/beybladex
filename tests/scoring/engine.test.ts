import { describe, expect, it } from "vitest";
import { scoreMatch, scoreSets, scoreText, ScoringError, type Battle } from "@/lib/scoring/engine";
import { PRESETS, ruleProfileSchema, rulesForMatch, type MatchRules } from "@/lib/scoring/profile";

const rules = (overrides: Partial<MatchRules> = {}): MatchRules => ({
  ...rulesForMatch(PRESETS["first-to-4"], { isFinals: false }),
  ...overrides,
});

const b = (kind: Battle["kind"], side: Battle["side"] = null): Battle => ({ kind, side });

describe("scoreMatch: single set, first to 4", () => {
  it("adds finish points to the scoring player", () => {
    const score = scoreMatch(rules(), [b("over", 1), b("spin", 2), b("spin", 1)]);
    expect(score.sets[0]).toEqual({ 1: 3, 2: 1, winner: null });
    expect(score.complete).toBe(false);
  });

  it("decides the match when a player reaches the target", () => {
    const score = scoreMatch(rules(), [b("over", 1), b("spin", 2), b("burst", 1)]);
    expect(score).toMatchObject({ winner: 1, complete: true, setsWon: { 1: 1, 2: 0 } });
  });

  it("keeps the real total when a finish goes past the target", () => {
    const score = scoreMatch(rules(), [b("burst", 1), b("spin", 2), b("spin", 2), b("xtreme", 1)]);
    expect(score.sets[0]).toEqual({ 1: 5, 2: 2, winner: 1 });
  });

  it("ignores draws (they are replayed)", () => {
    const score = scoreMatch(rules(), [b("draw"), b("spin", 1), b("draw")]);
    expect(score.sets[0]).toMatchObject({ 1: 1, 2: 0 });
    expect(score.log.map((e) => e.kind)).toEqual(["draw", "spin", "draw"]);
  });

  it("refuses battles after the match is decided", () => {
    expect(() => scoreMatch(rules(), [b("xtreme", 1), b("spin", 1), b("spin", 2)])).toThrow(ScoringError);
  });

  it("requires a player for finishes", () => {
    expect(() => scoreMatch(rules(), [b("spin")])).toThrow(/needs a player/);
  });
});

describe("launch errors", () => {
  it("gives the opponent a point on the second strike, then resets the count", () => {
    const score = scoreMatch(rules(), [b("launch_error", 1), b("launch_error", 1), b("launch_error", 1)]);
    expect(score.sets[0]).toMatchObject({ 1: 0, 2: 1 });
    expect(score.strikes).toEqual({ 1: 1, 2: 0 });
    expect(score.log[1]).toMatchObject({ awardedTo: 2, points: 1 });
  });

  it("can decide the match", () => {
    const score = scoreMatch(rules(), [b("xtreme", 2), b("launch_error", 1), b("launch_error", 1)]);
    expect(score.winner).toBe(2);
  });

  it("is rejected when the profile doesn't use it", () => {
    expect(() => scoreMatch(rules({ launchErrorPenalty: null }), [b("launch_error", 1)])).toThrow(/aren't used/);
  });
});

describe("own finishes", () => {
  it("award the configured points to the player who didn't self-KO", () => {
    const score = scoreMatch(rules({ ownFinishPoints: 1 }), [b("own", 2)]);
    expect(score.sets[0]).toMatchObject({ 1: 0, 2: 1 });
  });

  it("are rejected when the profile doesn't use them", () => {
    expect(() => scoreMatch(rules(), [b("own", 2)])).toThrow(/aren't used/);
  });
});

describe("best of 3 sets", () => {
  const bo3 = rules({ bestOfSets: 3 });

  it("starts a new set after each set win and resets strikes", () => {
    const score = scoreMatch(bo3, [b("launch_error", 2), b("xtreme", 1), b("spin", 1), b("spin", 2)]);
    expect(score.sets).toEqual([
      { 1: 4, 2: 0, winner: 1 },
      { 1: 0, 2: 1, winner: null },
    ]);
    expect(score.strikes).toEqual({ 1: 0, 2: 0 });
    expect(score.complete).toBe(false);
  });

  it("decides the match at two sets and reports one number per set", () => {
    const battles = [
      b("xtreme", 1), b("spin", 2), b("spin", 1), // 4–1
      b("burst", 1), b("burst", 2), b("over", 2), // 2–4
      b("xtreme", 1), b("over", 2), b("spin", 2), b("spin", 1), // 4–3
    ];
    const score = scoreMatch(bo3, battles);
    expect(score).toMatchObject({ winner: 1, setsWon: { 1: 2, 2: 1 }, currentSet: 2 });
    expect(scoreSets(bo3, score)).toEqual({ 1: "4,2,4", 2: "1,4,3" });
  });
});

describe("Challonge output", () => {
  it("reports actual points by default and capped points when configured", () => {
    const battles = [b("burst", 1), b("spin", 2), b("spin", 2), b("xtreme", 1)];
    expect(scoreSets(rules(), scoreMatch(rules(), battles))).toEqual({ 1: "5", 2: "2" });
    const capped = rules({ capAtTarget: true });
    expect(scoreSets(capped, scoreMatch(capped, battles))).toEqual({ 1: "4", 2: "2" });
  });

  it("writes the score as players read it, player 1 first, sets apart", () => {
    expect(scoreText(rules(), scoreMatch(rules(), [b("xtreme", 2), b("spin", 2)]))).toBe("0-4");
    const bo3 = rules({ bestOfSets: 3 });
    const sets = [b("xtreme", 1), b("spin", 1), b("xtreme", 2), b("spin", 2), b("xtreme", 1), b("spin", 1)];
    expect(scoreText(bo3, scoreMatch(bo3, sets))).toBe("4-0,0-4,4-0");
  });

  it("refuses to write the score of an undecided match", () => {
    expect(() => scoreText(rules(), scoreMatch(rules(), []))).toThrow(ScoringError);
  });
});

describe("rule profiles", () => {
  it("all presets are valid", () => {
    for (const preset of Object.values(PRESETS)) expect(ruleProfileSchema.parse(preset)).toEqual(preset);
  });

  it("applies the finals override only to finals", () => {
    const profile = PRESETS["first-to-4-bo3-finals"];
    expect(rulesForMatch(profile, { isFinals: false })).toMatchObject({ targetPoints: 4, bestOfSets: 1 });
    expect(rulesForMatch(profile, { isFinals: true })).toMatchObject({ targetPoints: 4, bestOfSets: 3, profileName: "First to 4 · Bo3 finals" });
  });

  it("rejects even best-of values", () => {
    expect(ruleProfileSchema.safeParse({ ...PRESETS["first-to-4"], bestOfSets: 2 }).success).toBe(false);
  });
});
