import { describe, expect, it } from "vitest";
import { lastBattleText } from "@/lib/scoring/describe";
import type { Battle } from "@/lib/scoring/engine";
import { PRESETS, rulesForMatch, type MatchRules } from "@/lib/scoring/profile";

const rules: MatchRules = rulesForMatch(PRESETS["first-to-4"], { isFinals: false });
const names = { 1: "Alex", 2: "Sam" };
const b = (kind: Battle["kind"], side: Battle["side"] = null): Battle => ({ kind, side });

describe("lastBattleText", () => {
  it("is empty before the first battle", () => {
    expect(lastBattleText(rules, [], names)).toBeNull();
  });

  it("names the scorer, the finish and the points of the latest battle only", () => {
    expect(lastBattleText(rules, [b("spin", 2), b("xtreme", 1)], names)).toBe("Alex · Xtreme +3");
    expect(lastBattleText(rules, [b("xtreme", 1), b("spin", 2)], names)).toBe("Sam · Spin +1");
  });

  it("uses the profile's own point values", () => {
    const custom = { ...rules, points: { ...rules.points, burst: 5 }, targetPoints: 7 };
    expect(lastBattleText(custom, [b("burst", 2)], names)).toBe("Sam · Burst +5");
  });

  it("describes a draw", () => {
    expect(lastBattleText(rules, [b("spin", 1), b("draw")], names)).toBe("Draw · replayed");
  });

  it("shows the strike count for a launch error that isn't penalised yet", () => {
    expect(lastBattleText(rules, [b("launch_error", 2)], names)).toBe("Sam launch error (strike 1 of 2)");
  });

  it("shows who gets the point when a launch error is penalised", () => {
    expect(lastBattleText(rules, [b("launch_error", 2), b("launch_error", 2)], names)).toBe("Sam launch error · +1 Alex");
  });

  it("describes an own finish when the profile uses it", () => {
    expect(lastBattleText({ ...rules, ownFinishPoints: 1 }, [b("own", 1)], names)).toBe("Alex · Own finish +1");
  });

  it("returns nothing rather than a broken line when the battles can't be scored", () => {
    // A battle recorded after the match was already decided.
    expect(lastBattleText(rules, [b("xtreme", 1), b("spin", 1), b("spin", 2)], names)).toBeNull();
  });
});
