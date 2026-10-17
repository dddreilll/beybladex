// The M2 loop against the real database: judge-pad ops → result → the bracket moves players on.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganizer, enabled, removeOrganizer, seedTournament, type Seeded } from "./helpers";

describe.skipIf(!enabled)("scoring and results against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq, and } = await import("drizzle-orm");
  const { applyBattleOps, activeBattles } = await import("@/lib/battles");
  const { submitResult } = await import("@/lib/tournament/results");

  let organizerId: string;
  let t: Seeded;

  const localMatch = async (number: number) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, t.tournamentId), eq(schema.matches.number, number)))
    )[0];

  const add = (kind: string, side: 1 | 2 | null) => ({ op: "add" as const, opId: randomUUID(), kind: kind as "spin", side });

  /** Scores a match to `winnerSide` 4–1 (Xtreme + Spin vs Spin) via judge-pad ops. */
  async function scoreTo(number: number, winnerSide: 1 | 2) {
    const match = await localMatch(number);
    const loser = winnerSide === 1 ? 2 : 1;
    return applyBattleOps(organizerId, match.id, [add("xtreme", winnerSide), add("spin", loser), add("spin", winnerSide)]);
  }

  async function clearBattles(number: number) {
    const match = await localMatch(number);
    const current = await activeBattles(match.id);
    await applyBattleOps(
      organizerId,
      match.id,
      current.map((b) => ({ op: "void" as const, opId: randomUUID(), targetOpId: b.opId })),
    );
  }

  beforeAll(async () => {
    organizerId = await createOrganizer();
    // 16 players, double elimination: A to H are winners round 1, I to L round 2, M to P losers round 1.
    t = await seedTournament(organizerId);
  });

  afterAll(async () => {
    await removeOrganizer(organizerId);
    await db.$client.end();
  });

  describe("judge pad operations", () => {
    it("records battles, snapshots the rules, and ignores replayed ops", async () => {
      const match = await localMatch(1);
      const ops = [add("over", 1), add("spin", 2)];
      const first = await applyBattleOps(organizerId, match.id, ops);
      const replay = await applyBattleOps(organizerId, match.id, ops);
      expect(first!.battles.map((b) => b.kind)).toEqual(["over", "spin"]);
      expect(replay!.battles).toHaveLength(2);
      expect((await localMatch(1)).ruleSnapshot).toMatchObject({ targetPoints: 4, profileName: "First to 4" });
    });

    it("undo voids the battle instead of deleting it", async () => {
      const match = await localMatch(1);
      const [, spin] = (await activeBattles(match.id))!;
      const result = await applyBattleOps(organizerId, match.id, [{ op: "void", opId: randomUUID(), targetOpId: spin.opId }]);
      expect(result!.battles.map((b) => b.kind)).toEqual(["over"]);
      const [row] = await db.select().from(schema.battles).where(eq(schema.battles.opId, spin.opId));
      expect(row).toMatchObject({ voidReason: "undo" });
      expect(row.voidedAt).not.toBeNull();
    });

    it("rejects battles after the match is decided and on matches without both players", async () => {
      const match = await localMatch(1);
      const result = await applyBattleOps(organizerId, match.id, [add("burst", 1), add("spin", 2)]);
      expect(result!.battles.map((b) => b.kind)).toEqual(["over", "burst"]);
      expect(result!.rejected[0].reason).toMatch(/already decided/);

      const pending = await localMatch(9);
      const blocked = await applyBattleOps(organizerId, pending.id, [add("spin", 1)]);
      expect(blocked!.rejected[0].reason).toMatch(/Both players/);
    });

    it("refuses another organizer's match", async () => {
      expect(await applyBattleOps(randomUUID(), (await localMatch(1)).id, [add("spin", 1)])).toBeNull();
      expect(await submitResult(randomUUID(), (await localMatch(1)).id)).toMatchObject({ status: "invalid" });
    });
  });

  describe("results", () => {
    it("refuses an undecided match", async () => {
      expect(await submitResult(organizerId, (await localMatch(2)).id)).toMatchObject({ status: "invalid", error: "The match isn't decided yet." });
    });

    it("records the result and moves the winner on in the winners bracket and the loser to the losers bracket", async () => {
      const outcome = await submitResult(organizerId, (await localMatch(1)).id);
      expect(outcome).toEqual({ status: "synced" });

      const a = await localMatch(1);
      expect(a).toMatchObject({ state: "complete", winnerId: t.id("Blader 01"), scores: "4-0", reportedBy: organizerId });
      expect(a.reportedAt).not.toBeNull();
      expect(await localMatch(9)).toMatchObject({ player1Id: t.id("Blader 01"), state: "pending" });
      expect(await localMatch(13)).toMatchObject({ player1Id: t.id("Blader 16"), state: "pending" });
    });

    it("records the same result again without changing anything", async () => {
      expect(await submitResult(organizerId, (await localMatch(1)).id)).toEqual({ status: "synced" });
      expect(await localMatch(9)).toMatchObject({ player1Id: t.id("Blader 01") });
    });

    it("corrects a winner without confirmation while nothing downstream has been played", async () => {
      await clearBattles(1);
      await scoreTo(1, 2);
      expect(await submitResult(organizerId, (await localMatch(1)).id)).toEqual({ status: "synced" });
      expect(await localMatch(1)).toMatchObject({ winnerId: t.id("Blader 16"), scores: "1-4" });
      expect(await localMatch(9)).toMatchObject({ player1Id: t.id("Blader 16") });
      expect(await localMatch(13)).toMatchObject({ player1Id: t.id("Blader 01") });
    });

    it("asks before a correction that would erase a played match, then voids that match's battles", async () => {
      await scoreTo(2, 1); // Blader 08 beats Blader 09
      expect(await submitResult(organizerId, (await localMatch(2)).id)).toEqual({ status: "synced" });
      await scoreTo(9, 1); // Blader 16 beats Blader 08
      expect(await submitResult(organizerId, (await localMatch(9)).id)).toEqual({ status: "synced" });
      const i = await localMatch(9);
      expect(i.state).toBe("complete");

      await clearBattles(1);
      await scoreTo(1, 1);
      const ask = await submitResult(organizerId, (await localMatch(1)).id);
      expect(ask).toEqual({ status: "needs_confirmation", affected: ["Winners R2 · Match 9 (4-1)"] });
      // Nothing changed while the organizer decides.
      expect(await localMatch(1)).toMatchObject({ winnerId: t.id("Blader 16") });

      const confirmed = await submitResult(organizerId, (await localMatch(1)).id, { confirmDestructive: true });
      expect(confirmed).toEqual({ status: "synced" });
      expect(await localMatch(9)).toMatchObject({ state: "open", winnerId: null, player1Id: t.id("Blader 01"), ruleSnapshot: null, scores: null });
      expect(await activeBattles(i.id)).toEqual([]);
      const voided = await db.select().from(schema.battles).where(eq(schema.battles.matchId, i.id));
      expect(voided.every((b) => b.voidReason === "reset_by_correction")).toBe(true);
      // The loser of I had gone on to the losers bracket; that slot is empty again.
      const [dropped] = await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, t.tournamentId), eq(schema.matches.key, i.loserTo!.match)));
      expect([dropped.player1Id, dropped.player2Id]).not.toContain(t.id("Blader 08"));
    });

    it("takes two results at once, one after the other", async () => {
      await scoreTo(3, 1);
      await scoreTo(4, 2);
      const [c, d] = await Promise.all([localMatch(3), localMatch(4)]);
      expect(await Promise.all([submitResult(organizerId, c.id), submitResult(organizerId, d.id)])).toEqual([{ status: "synced" }, { status: "synced" }]);
      const j = await localMatch(10);
      expect([j.player1Id, j.player2Id].every(Boolean)).toBe(true);
    });
  });
});
