import { describe, expect, it } from "vitest";
import { callLabel } from "@/lib/call-label";
import { callPayload } from "@/lib/push-endpoint";

describe("callLabel", () => {
  it("has no label for the first call", () => {
    expect(callLabel(0)).toBeNull();
    expect(callLabel(1)).toBeNull();
  });

  it("never renders a broken label when the count is missing or invalid", () => {
    // Regression: a card once showed "undefinedth call" when the count didn't reach it.
    for (const bad of [undefined, null, Number.NaN, 2.5, "2"]) {
      expect(callLabel(bad as number | undefined)).toBeNull();
    }
  });

  it.each([
    [2, "Second call"],
    [3, "Third call"],
    [10, "Tenth call"],
    [11, "11th call"],
    [12, "12th call"],
    [21, "21st call"],
    [22, "22nd call"],
    [23, "23rd call"],
  ])("call %i is announced as %s", (n, expected) => {
    expect(callLabel(n)).toBe(expected);
  });
});

describe("callPayload for recalls", () => {
  const base = { status: "called" as const, stadium: "Stadium 2", opponent: "Sam", label: "Winners R2 · I", slug: "abcdef0123456789", matchId: "m1" };

  it("keeps the normal title on the first call", () => {
    expect(callPayload({ ...base, callNumber: 1 }).title).toBe("You're up at Stadium 2");
  });

  it("leads with the repeat number on a recall and replaces the earlier notification", () => {
    const second = callPayload({ ...base, callNumber: 2 });
    expect(second.title).toBe("Second call: Stadium 2");
    expect(second.tag).toBe(callPayload({ ...base, callNumber: 1 }).tag);
  });

  it("never numbers an on-deck notice", () => {
    expect(callPayload({ ...base, status: "on_deck", callNumber: 3 }).title).toBe("On deck at Stadium 2");
  });
});
