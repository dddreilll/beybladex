// Two-stage tournaments against the real database: groups made by snaking the seeds, the group
// stage ended (who goes through, crossed into the final stage), the final stage, and finishing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bladers, createOrganizer, enabled, playMatch, playOut, removeOrganizer, seedTournament, type Seeded } from "./helpers";

describe.skipIf(!enabled)("two-stage tournaments against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq, and, asc } = await import("drizzle-orm");
  const { endGroupStage, startFinalStage, finishTournament } = await import("@/lib/tournament/stages");
  const { submitResult } = await import("@/lib/tournament/results");
  const { boardSnapshot, playerSnapshot } = await import("@/lib/board");
  const { buildControlRoom } = await import("@/lib/control-room");
  const { rulesFor } = await import("@/lib/rules");

  let organizerId: string;
  const tournament = async (id: string) => (await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, id)))[0];
  const people = (id: string) => db.select().from(schema.participants).where(eq(schema.participants.tournamentId, id));
  const stageMatches = (id: string, stage: "group" | "final") =>
    db.select().from(schema.matches).where(and(eq(schema.matches.tournamentId, id), eq(schema.matches.stage, stage))).orderBy(asc(schema.matches.playOrder));

  beforeAll(async () => {
    organizerId = await createOrganizer();
  });

  afterAll(async () => {
    await removeOrganizer(organizerId);
    await db.$client.end();
  });

  describe("round robin groups, then single elimination", () => {
    let t: Seeded;
    beforeAll(async () => {
      t = await seedTournament(organizerId, {
        format: "single_elimination",
        players: bladers(8),
        groupStage: { format: "round_robin", groups: 2, advance: 2 },
      });
    });

    it("snakes the seeds into the groups and starts every group's matches", async () => {
      expect((await tournament(t.tournamentId)).state).toBe("group_stage");
      const groups = (await people(t.tournamentId)).sort((a, b) => a.seed! - b.seed!).map((p) => p.groupNumber);
      expect(groups).toEqual([1, 2, 2, 1, 1, 2, 2, 1]);
      const matches = await stageMatches(t.tournamentId, "group");
      expect(matches).toHaveLength(12);
      expect(matches.every((m) => m.state === "open" && m.groupNumber && m.key.startsWith(`G${m.groupNumber}:`))).toBe(true);
    });

    it("names the group in the queue, and lets the groups take turns", async () => {
      const room = buildControlRoom(await tournament(t.tournamentId), await people(t.tournamentId), await stageMatches(t.tournamentId, "group"));
      expect(room.ready.slice(0, 2).map((m) => m.roundLabel)).toEqual(["Group A · Round 1", "Group B · Round 1"]);
    });

    it("won't end the group stage, start the final stage or finish while group matches are open", async () => {
      expect(await endGroupStage(organizerId, t.tournamentId)).toEqual({ status: "blocked", error: "No match has been played yet." });
      expect(await startFinalStage(organizerId, t.tournamentId)).toEqual({ status: "blocked", error: "End the group stage first." });
      expect(await finishTournament(organizerId, t.tournamentId)).toEqual({ status: "blocked", error: "The group stage is still being played." });
    });

    it("ends the group stage and works out who goes through, group winners first, crossed", async () => {
      await playOut(organizerId, t, { stage: "group" });
      expect(await endGroupStage(organizerId, t.tournamentId)).toEqual({ status: "done" });
      expect((await tournament(t.tournamentId)).state).toBe("between_stages");
      const through = (await people(t.tournamentId)).filter((p) => p.advanced).sort((a, b) => a.finalSeed! - b.finalSeed!);
      // Group A: 01, 04, 05, 08; group B: 02, 03, 06, 07. Winners 01 and 02, then 04 and 03.
      expect(through.map((p) => p.name)).toEqual(["Blader 01", "Blader 02", "Blader 04", "Blader 03"]);
      expect((await people(t.tournamentId)).filter((p) => p.advanced === false)).toHaveLength(4);
    });

    it("tells each player on their Pass whether they went through, and shows the group standings on the board", async () => {
      expect((await playerSnapshot(t.slug, t.id("Blader 04")))!.status).toEqual({ kind: "advanced" });
      expect((await playerSnapshot(t.slug, t.id("Blader 05")))!.status).toEqual({ kind: "out" });
      expect((await boardSnapshot(t.slug))!.tables.map((x) => x.title)).toEqual(["Group A", "Group B"]);
    });

    it("refuses to change a group result once the group stage has ended", async () => {
      const [first] = await stageMatches(t.tournamentId, "group");
      expect(await submitResult(organizerId, first.id)).toEqual({ status: "invalid", error: "The group stage has ended, so its results can't be changed." });
    });

    it("starts the final stage with the players who went through, none meeting their own group first", async () => {
      expect(await startFinalStage(organizerId, t.tournamentId)).toEqual({ status: "done" });
      expect((await tournament(t.tournamentId)).state).toBe("underway");
      const final = await stageMatches(t.tournamentId, "final");
      expect(final.map((m) => [m.playOrder, t.name(m.player1Id), t.name(m.player2Id)])).toEqual([
        [1, "Blader 01", "Blader 03"],
        [2, "Blader 02", "Blader 04"],
        [3, null, null],
      ]);
      // Numbered on from the group stage's last match.
      const last = Math.max(...(await stageMatches(t.tournamentId, "group")).map((m) => m.number ?? 0));
      expect(final.map((m) => m.number)).toEqual([last + 1, last + 2, last + 3]);
    });

    it("gives the finals rules to the final of the final stage only", async () => {
      const t0 = await tournament(t.tournamentId);
      await db.update(schema.tournaments).set({ rulePresetKey: "first-to-4-bo3-finals" }).where(eq(schema.tournaments.id, t.tournamentId));
      const [semi, , final] = await stageMatches(t.tournamentId, "final");
      const fresh = await tournament(t.tournamentId);
      expect((await rulesFor(fresh, final)).bestOfSets).toBe(3);
      expect((await rulesFor(fresh, semi)).bestOfSets).toBe(1);
      const [group] = await stageMatches(t.tournamentId, "group");
      expect((await rulesFor(fresh, group)).bestOfSets).toBe(1);
      await db.update(schema.tournaments).set({ rulePresetKey: t0.rulePresetKey }).where(eq(schema.tournaments.id, t.tournamentId));
    });

    it("finishes and places everyone: the final stage first, then the others by their place in their group", async () => {
      await playOut(organizerId, t, { stage: "final" });
      expect(await finishTournament(organizerId, t.tournamentId)).toEqual({ status: "finished", ranked: 8 });
      const ranks = Object.fromEntries((await people(t.tournamentId)).map((p) => [p.name, p.finalRank]));
      expect(ranks).toEqual({
        "Blader 01": 1,
        "Blader 02": 2,
        "Blader 03": 3,
        "Blader 04": 3,
        // Each group's 3rd shares 5th, each group's 4th shares 7th.
        "Blader 05": 5,
        "Blader 06": 5,
        "Blader 08": 7,
        "Blader 07": 7,
      });
    });
  });

  describe("Swiss groups", () => {
    it("pairs each group's next round from its own results, whatever the other group is doing", async () => {
      const t = await seedTournament(organizerId, { format: "single_elimination", players: bladers(8), groupStage: { format: "swiss", groups: 2, advance: 1 } });
      const groupA = (await stageMatches(t.tournamentId, "group")).filter((m) => m.groupNumber === 1);
      expect(groupA).toHaveLength(2);
      for (const m of groupA) expect(await playMatch(organizerId, m.id, 1)).toEqual({ status: "synced" });
      const rounds = (await stageMatches(t.tournamentId, "group")).map((m) => `${m.groupNumber}:${m.round}`);
      expect(rounds.filter((r) => r === "1:2")).toHaveLength(2);
      expect(rounds.filter((r) => r === "2:2")).toHaveLength(0);
      // Groups of 4 play 2 rounds; then the group stage can end.
      await playOut(organizerId, t, { stage: "group" });
      expect(await endGroupStage(organizerId, t.tournamentId)).toEqual({ status: "done" });
      expect((await people(t.tournamentId)).filter((p) => p.advanced).map((p) => p.name).sort()).toEqual(["Blader 01", "Blader 02"]);
    });
  });

  describe("double elimination groups, then a round robin", () => {
    it("plays each group's bracket to the end, ranks it by place, and runs a round robin final stage", async () => {
      const t = await seedTournament(organizerId, {
        format: "round_robin",
        players: bladers(8),
        groupStage: { format: "double_elimination", groups: 2, advance: 2 },
      });
      const room = buildControlRoom(await tournament(t.tournamentId), await people(t.tournamentId), await stageMatches(t.tournamentId, "group"));
      expect(room.ready[0].roundLabel).toBe("Group A · Winners R1");
      await playOut(organizerId, t, { stage: "group" });
      expect(await endGroupStage(organizerId, t.tournamentId)).toEqual({ status: "done" });
      expect(await startFinalStage(organizerId, t.tournamentId)).toEqual({ status: "done" });
      const final = await stageMatches(t.tournamentId, "final");
      expect(final).toHaveLength(6);
      expect(final.every((m) => m.state === "open")).toBe(true);
      await playOut(organizerId, t, { stage: "final" });
      expect(await finishTournament(organizerId, t.tournamentId)).toEqual({ status: "finished", ranked: 8 });
      expect((await boardSnapshot(t.slug))!.standings!.slice(0, 4).map((s) => s.name)).toEqual(["Blader 01", "Blader 02", "Blader 03", "Blader 04"]);
    });
  });
});
