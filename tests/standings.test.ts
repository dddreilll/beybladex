import { describe, expect, it } from "vitest";
import { pointsOf, standingsTables } from "@/lib/standings";

type Match = Parameters<typeof standingsTables>[1][number];
type Player = Parameters<typeof standingsTables>[2][number];

const players: Player[] = ["Aki", "Ben", "Carlo", "Dani", "Eli", "Faye"].map((name, i) => ({
  id: `p${i + 1}`,
  name,
  active: true,
  advanced: null,
  seed: i + 1,
  finalSeed: null,
  groupNumber: null,
}));
const id = (name: string) => players.find((p) => p.name === name)!.id;
/** A match between two players by name; the first wins unless `winner` says otherwise. */
const played = (a: string, b: string, extra: Partial<Match> & { winner?: string } = {}): Match => ({
  stage: "final",
  groupNumber: null,
  player1Id: id(a),
  player2Id: id(b),
  winnerId: id(extra.winner ?? a),
  scores: null,
  bye: false,
  ...extra,
});
const open = (a: string, b: string, extra: Partial<Match> = {}): Match => ({ ...played(a, b, extra), winnerId: null });
const bye = (a: string): Match => ({ ...played(a, a), player2Id: null, bye: true });
const rows = (tables: ReturnType<typeof standingsTables>, key: string) =>
  tables.find((t) => t.key === key)!.rows.map((r) => `${r.rank} ${r.name} ${r.record}`);

const roundRobin = { tournamentType: "round_robin", groupStage: false, state: "underway" };

describe("pointsOf", () => {
  it("adds up the points of every set, player 1 first", () => {
    expect(pointsOf("4-2")).toEqual([4, 2]);
    expect(pointsOf("4-1,2-4,4-3")).toEqual([10, 8]);
    expect(pointsOf(null)).toBeUndefined();
    expect(pointsOf("4 - 2 x")).toBeUndefined();
  });
});

describe("standingsTables", () => {
  it("ranks a round robin by wins, then Buchholz and head-to-head, with every place its own", () => {
    const four = players.slice(0, 4);
    const matches = [played("Aki", "Ben"), played("Aki", "Carlo"), played("Dani", "Aki"), played("Ben", "Carlo"), played("Ben", "Dani"), played("Carlo", "Dani")];
    const tables = standingsTables(roundRobin, matches, four);
    expect(tables.map((t) => `${t.key}:${t.title}:${t.current}`)).toEqual(["all:Standings:true"]);
    // Aki and Ben are both 2-1 with the same Buchholz; Aki beat Ben.
    expect(rows(tables, "all")).toEqual(["1 Aki 2-1", "2 Ben 2-1", "3 Carlo 1-2", "4 Dani 1-2"]);
  });

  it("counts only decided matches, lists a player without a match, and counts a Swiss bye as a win", () => {
    const matches = [played("Aki", "Ben"), played("Carlo", "Dani"), bye("Eli"), open("Aki", "Faye")];
    // Without a win, Ben and Dani are ahead of Faye on Buchholz: they met players who won.
    expect(rows(standingsTables({ ...roundRobin, tournamentType: "swiss" }, matches, players), "all")).toEqual([
      "1 Aki 1-0",
      "2 Carlo 1-0",
      "3 Eli 1-0",
      "4 Ben 0-1",
      "5 Dani 0-1",
      "6 Faye 0-0",
    ]);
  });

  it("breaks a tie still left by points difference", () => {
    const matches = [played("Aki", "Ben", { scores: "4-3" }), played("Carlo", "Dani", { scores: "4-0" })];
    expect(rows(standingsTables(roundRobin, matches, players.slice(0, 4)), "all").slice(0, 2)).toEqual(["1 Carlo 1-0", "2 Aki 1-0"]);
  });

  it("marks a player who dropped out", () => {
    const dropped = players.slice(0, 2).map((p) => (p.name === "Ben" ? { ...p, active: false } : p));
    const [table] = standingsTables(roundRobin, [played("Aki", "Ben")], dropped);
    expect(table.rows.map((r) => `${r.name}:${r.dropped}`)).toEqual(["Aki:false", "Ben:true"]);
  });

  it("has none for a bracket without groups, nor before the tournament starts", () => {
    expect(standingsTables({ tournamentType: "single_elimination", groupStage: false, state: "underway" }, [played("Aki", "Ben")], players)).toEqual([]);
    expect(standingsTables({ tournamentType: "double_elimination", groupStage: false, state: "underway" }, [played("Aki", "Ben")], players)).toEqual([]);
    expect(standingsTables({ ...roundRobin, state: "pending" }, [], players)).toEqual([]);
  });

  describe("in a two-stage tournament", () => {
    const grouped = players.map((p) => ({ ...p, groupNumber: ["Aki", "Ben", "Carlo"].includes(p.name) ? 1 : 2 }));
    const groupA = [played("Aki", "Ben", { stage: "group", groupNumber: 1 }), played("Aki", "Carlo", { stage: "group", groupNumber: 1 }), played("Ben", "Carlo", { stage: "group", groupNumber: 1 })];
    const groupB = [played("Dani", "Eli", { stage: "group", groupNumber: 2 }), open("Dani", "Faye", { stage: "group", groupNumber: 2 })];
    const format = (state: string, tournamentType = "single_elimination") => ({ tournamentType, groupStage: true, groupStageType: "round_robin", state });

    it("has one table for each group while the groups are played, with every player of the group", () => {
      const tables = standingsTables(format("group_stage"), [...groupA, ...groupB], grouped);
      expect(tables.map((t) => `${t.key}:${t.title}:${t.current}`)).toEqual(["group-1:Group A:true", "group-2:Group B:true"]);
      expect(rows(tables, "group-1")).toEqual(["1 Aki 2-0", "2 Ben 1-1", "3 Carlo 0-2"]);
      expect(rows(tables, "group-2")).toEqual(["1 Dani 1-0", "2 Eli 0-1", "3 Faye 0-0"]);
    });

    it("says who went through once the group stage has ended", () => {
      const ended = grouped.map((p) => ({ ...p, advanced: ["Aki", "Ben", "Dani", "Faye"].includes(p.name) }));
      const [first] = standingsTables(format("between_stages"), groupA, ended);
      expect(first.rows.map((r) => `${r.name}:${r.advanced}`)).toEqual(["Aki:true", "Ben:true", "Carlo:false"]);
      expect(first.current).toBe(true);
    });

    it("keeps the groups, no longer current, when the final stage is a bracket", () => {
      const tables = standingsTables(format("underway"), [...groupA, played("Aki", "Dani")], grouped);
      expect(tables.map((t) => `${t.key}:${t.current}`)).toEqual(["group-1:false", "group-2:false"]);
    });

    it("puts a round robin or Swiss final stage first, with only the players who went through, in their final-stage seeds", () => {
      const through = grouped.map((p) => ({ ...p, advanced: ["Aki", "Ben", "Dani", "Faye"].includes(p.name), finalSeed: { Aki: 1, Dani: 2, Ben: 3, Faye: 4 }[p.name] ?? null }));
      for (const type of ["round_robin", "swiss"]) {
        const tables = standingsTables(format("underway", type), [...groupA, ...groupB, played("Ben", "Aki"), open("Dani", "Faye")], through);
        expect(tables.map((t) => `${t.key}:${t.current}`)).toEqual(["final:true", "group-1:false", "group-2:false"]);
        expect(rows(tables, "final")).toEqual(["1 Ben 1-0", "2 Aki 0-1", "3 Dani 0-0", "4 Faye 0-0"]);
      }
    });
  });
});
