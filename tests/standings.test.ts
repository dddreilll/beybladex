import { describe, expect, it } from "vitest";
import { standingsTables } from "@/lib/standings";

type Match = Parameters<typeof standingsTables>[1][number];

const players = ["Aki", "Ben", "Carlo", "Dani", "Eli", "Faye"].map((name, i) => ({ challongeId: String(i + 1), name, active: true, advanced: null }));
const id = (name: string) => players.find((p) => p.name === name)!.challongeId;
/** A match between two players by name; the first wins unless `winner` says otherwise ("none" for a tie). */
const played = (a: string, b: string, extra: Partial<Match> & { winner?: string } = {}): Match => ({
  stage: "final",
  groupNumber: null,
  state: "complete",
  player1ChallongeId: id(a),
  player2ChallongeId: id(b),
  winnerChallongeId: extra.winner === "none" ? null : id(extra.winner ?? a),
  ...extra,
});
const open = (a: string, b: string, extra: Partial<Match> = {}): Match => ({ ...played(a, b, extra), state: "open", winnerChallongeId: null });
const rows = (tables: ReturnType<typeof standingsTables>, key: string) =>
  tables.find((t) => t.key === key)!.rows.map((r) => `${r.rank} ${r.name} ${r.record}`);

const roundRobin = { tournamentType: "round robin", groupStage: false, state: "underway" };

describe("standingsTables", () => {
  it("ranks a round robin by record, and gives the same record the same place", () => {
    const four = players.slice(0, 4);
    const matches = [played("Aki", "Ben"), played("Aki", "Carlo"), played("Dani", "Aki"), played("Ben", "Carlo"), played("Ben", "Dani"), played("Carlo", "Dani")];
    const tables = standingsTables(roundRobin, matches, four);
    expect(tables.map((t) => `${t.key}:${t.title}:${t.current}`)).toEqual(["all:Standings:true"]);
    expect(rows(tables, "all")).toEqual(["1 Aki 2-1", "1 Ben 2-1", "3 Carlo 1-2", "3 Dani 1-2"]);
  });

  it("counts only complete matches, puts fewer losses first, and lists a player without a match", () => {
    const matches = [played("Aki", "Ben"), played("Carlo", "Dani"), played("Carlo", "Eli"), open("Aki", "Faye")];
    // Swiss can leave a player without an opponent in a round: Faye has played nothing yet.
    expect(rows(standingsTables({ ...roundRobin, tournamentType: "swiss" }, matches, players), "all")).toEqual([
      "1 Carlo 2-0",
      "2 Aki 1-0",
      "3 Faye 0-0",
      "4 Ben 0-1",
      "4 Dani 0-1",
      "4 Eli 0-1",
    ]);
  });

  it("counts a tie entered on Challonge as half a win, and shows it in the record", () => {
    const tables = standingsTables(roundRobin, [played("Aki", "Ben", { winner: "none" }), played("Aki", "Carlo")], players.slice(0, 3));
    expect(rows(tables, "all")).toEqual(["1 Aki 1-0-1", "2 Ben 0-0-1", "3 Carlo 0-1"]);
  });

  it("marks a player who dropped out", () => {
    const dropped = players.slice(0, 2).map((p) => (p.name === "Ben" ? { ...p, active: false } : p));
    const [table] = standingsTables(roundRobin, [played("Aki", "Ben")], dropped);
    expect(table.rows.map((r) => `${r.name}:${r.dropped}`)).toEqual(["Aki:false", "Ben:true"]);
  });

  it("has none for a bracket without groups", () => {
    expect(standingsTables({ tournamentType: "single elimination", groupStage: false, state: "underway" }, [played("Aki", "Ben")], players)).toEqual([]);
    expect(standingsTables({ tournamentType: "double elimination", groupStage: false, state: "underway" }, [played("Aki", "Ben")], players)).toEqual([]);
  });

  describe("in a two-stage tournament", () => {
    const groupA = [played("Aki", "Ben", { stage: "group", groupNumber: 1 }), played("Aki", "Carlo", { stage: "group", groupNumber: 1 }), played("Ben", "Carlo", { stage: "group", groupNumber: 1 })];
    const groupB = [played("Dani", "Eli", { stage: "group", groupNumber: 2 }), open("Dani", "Faye", { stage: "group", groupNumber: 2 })];
    const format = (state: string, tournamentType = "single elimination") => ({ tournamentType, groupStage: true, groupStageType: "round robin", state });

    it("has one table for each group while the groups are played", () => {
      const tables = standingsTables(format("group_stages_underway"), [...groupA, ...groupB], players);
      expect(tables.map((t) => `${t.key}:${t.title}:${t.current}`)).toEqual(["group-1:Group A:true", "group-2:Group B:true"]);
      expect(rows(tables, "group-1")).toEqual(["1 Aki 2-0", "2 Ben 1-1", "3 Carlo 0-2"]);
      // A group's players are those of its matches, played or not.
      expect(rows(tables, "group-2")).toEqual(["1 Dani 1-0", "2 Faye 0-0", "3 Eli 0-1"]);
    });

    it("names one table for the whole group stage when the groups couldn't be told apart", () => {
      const unknown = [...groupA, ...groupB].map((m) => ({ ...m, groupNumber: null }));
      expect(standingsTables(format("group_stages_underway"), unknown, players).map((t) => t.title)).toEqual(["Group stage"]);
    });

    it("says who advanced once the group stage has ended", () => {
      const ended = players.map((p) => ({ ...p, advanced: ["Aki", "Ben", "Dani", "Faye"].includes(p.name) }));
      const [first] = standingsTables(format("group_stages_finalized"), groupA, ended);
      expect(first.rows.map((r) => `${r.name}:${r.advanced}`)).toEqual(["Aki:true", "Ben:true", "Carlo:false"]);
      expect(first.current).toBe(true);
    });

    it("keeps the groups, no longer current, when the final stage is a bracket", () => {
      const tables = standingsTables(format("underway"), [...groupA, played("Aki", "Dani")], players);
      expect(tables.map((t) => `${t.key}:${t.current}`)).toEqual(["group-1:false"]);
    });

    it("puts a round robin or Swiss final stage first, with only the players in it", () => {
      for (const type of ["round robin", "swiss"]) {
        const tables = standingsTables(format("underway", type), [...groupA, ...groupB, played("Ben", "Aki"), open("Dani", "Faye")], players);
        expect(tables.map((t) => `${t.key}:${t.current}`)).toEqual(["final:true", "group-1:false", "group-2:false"]);
        expect(rows(tables, "final")).toEqual(["1 Ben 1-0", "2 Dani 0-0", "2 Faye 0-0", "4 Aki 0-1"]);
      }
    });
  });
});
