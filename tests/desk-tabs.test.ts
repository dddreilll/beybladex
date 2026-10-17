import { describe, expect, it } from "vitest";
import { deskTabs, openTab } from "@/lib/desk-tabs";

describe("deskTabs", () => {
  it("has only the players before the start", () => {
    expect(deskTabs({ pending: true, standings: true })).toEqual(["players"]);
  });

  it("adds standings only for the formats that have them", () => {
    expect(deskTabs({ pending: false, standings: false })).toEqual(["queue", "players", "completed", "bracket"]);
    expect(deskTabs({ pending: false, standings: true })).toEqual(["queue", "standings", "players", "completed", "bracket"]);
  });
});

describe("openTab", () => {
  const tabs = deskTabs({ pending: false, standings: false });

  it("opens the tab in the address, or the first one", () => {
    expect(openTab("completed", tabs)).toBe("completed");
    expect(openTab(undefined, tabs)).toBe("queue");
  });

  it("falls back to the first tab for one the tournament doesn't have, or a repeated parameter", () => {
    expect(openTab("standings", tabs)).toBe("queue");
    expect(openTab("nonsense", tabs)).toBe("queue");
    expect(openTab(["players", "queue"], tabs)).toBe("queue");
    expect(openTab("queue", deskTabs({ pending: true, standings: false }))).toBe("players");
  });
});
