import { describe, expect, it } from "vitest";
import { battleWords, lastBattleText, sheetLines } from "@/lib/scoring/describe";
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

describe("sheetLines", () => {
  const line = (l: { number: number; who: string | null; what: string; points: number; score: string }) =>
    `B${l.number} ${l.who ?? "-"} ${l.what} +${l.points} ${l.score}`;

  it("lists every battle with its points and the score after it", () => {
    const lines = sheetLines(rules, [b("over", 1), b("xtreme", 2), b("spin", 1), b("spin", 1)], names)!;
    expect(lines.map(line)).toEqual(["B1 Alex Over +2 2–0", "B2 Sam Xtreme +3 2–3", "B3 Alex Spin +1 3–3", "B4 Alex Spin +1 4–3"]);
    expect(lines.every((l) => l.set === 0 && l.note === null)).toBe(true);
  });

  it("keeps draws and unpenalised launch errors in the list without moving the score", () => {
    const lines = sheetLines(rules, [b("spin", 1), b("draw"), b("launch_error", 2)], names)!;
    expect(lines.map(line)).toEqual(["B1 Alex Spin +1 1–0", "B2 - Draw · replayed +0 1–0", "B3 Sam Launch error +0 1–0"]);
    expect(lines[2].note).toBe("Strike 1 of 2");
  });

  it("gives the penalty point to the opponent and starts the strikes again", () => {
    const lines = sheetLines(rules, [b("launch_error", 2), b("launch_error", 2), b("launch_error", 2)], names)!;
    expect(lines.map((l) => `${l.note} | +${l.points} ${l.score}`)).toEqual([
      "Strike 1 of 2 | +0 0–0",
      "Strike 2 of 2: point to Alex | +1 1–0",
      "Strike 1 of 2 | +0 1–0",
    ]);
    expect(lines[1].who).toBe("Sam");
  });

  it("starts the score and the strikes again in each set", () => {
    const bestOf3 = { ...rules, bestOfSets: 3 };
    const lines = sheetLines(bestOf3, [b("launch_error", 1), b("xtreme", 1), b("spin", 1), b("launch_error", 1), b("xtreme", 2)], names)!;
    expect(lines.map((l) => `set ${l.set + 1}: ${l.score}`)).toEqual(["set 1: 0–0", "set 1: 3–0", "set 1: 4–0", "set 2: 0–0", "set 2: 0–3"]);
    // One strike in each set: the second isn't "strike 2".
    expect(lines[3].note).toBe("Strike 1 of 2");
  });

  it("numbers battles through the whole match, not per set", () => {
    const bestOf3 = { ...rules, bestOfSets: 3 };
    const lines = sheetLines(bestOf3, [b("xtreme", 1), b("spin", 1), b("xtreme", 2)], names)!;
    expect(lines.map((l) => l.number)).toEqual([1, 2, 3]);
  });

  it("returns nothing rather than a wrong sheet when the battles can't be scored", () => {
    expect(sheetLines(rules, [b("xtreme", 1), b("spin", 1), b("spin", 2)], names)).toBeNull();
    expect(sheetLines(rules, [], names)).toEqual([]);
  });
});

describe("battleWords", () => {
  it("names the player and the finish, for battles that no longer count", () => {
    expect(battleWords(b("burst", 2), names)).toEqual({ who: "Sam", what: "Burst" });
    expect(battleWords(b("launch_error", 1), names)).toEqual({ who: "Alex", what: "Launch error" });
    expect(battleWords(b("draw"), names)).toEqual({ who: null, what: "Draw · replayed" });
  });
});
