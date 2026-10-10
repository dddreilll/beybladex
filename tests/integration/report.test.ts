// The M2 loop against the real database: judge-pad ops → result → Challonge (stubbed) → refresh.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeChallonge } from "./fake-challonge";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

describe.skipIf(!enabled)("scoring and reporting against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq, and, desc } = await import("drizzle-orm");
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials } = await import("@/lib/challonge/connection");
  const { importTournament } = await import("@/lib/challonge/sync");
  const { monthlyUsage } = await import("@/lib/challonge/budget");
  const { applyBattleOps, activeBattles } = await import("@/lib/battles");
  const { submitResult } = await import("@/lib/challonge/report");

  const fake = createFakeChallonge();
  const organizerId = randomUUID();
  let tournamentId: string;
  let connectionId: string;

  const P = { a1: "306531079", a2: "306531094", b1: "306531086", b2: "306531087" };

  const localMatch = async (identifier: string) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.identifier, identifier)))
    )[0];

  const add = (kind: string, side: 1 | 2 | null) => ({ op: "add" as const, opId: randomUUID(), kind: kind as "spin", side });

  /** Scores a match to `winnerSide` 4–1 (Xtreme + Spin vs Spin) via judge-pad ops. */
  async function scoreTo(identifier: string, winnerSide: 1 | 2) {
    const match = await localMatch(identifier);
    const loser = winnerSide === 1 ? 2 : 1;
    return applyBattleOps(organizerId, match.id, [add("xtreme", winnerSide), add("spin", loser), add("spin", winnerSide)]);
  }

  async function clearBattles(identifier: string) {
    const match = await localMatch(identifier);
    const current = await activeBattles(match.id);
    await applyBattleOps(
      organizerId,
      match.id,
      current.map((b) => ({ op: "void" as const, opId: randomUUID(), targetOpId: b.opId })),
    );
  }

  beforeAll(async () => {
    vi.stubGlobal("fetch", fake.fetch);
    await db.execute(sql`insert into auth.users (id, email, aud, role, instance_id)
      values (${organizerId}, ${`it-${organizerId}@example.test`}, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`);
    await saveCredentials(organizerId, "client", "secret");
    const [conn] = await db.select().from(schema.challongeConnections).where(eq(schema.challongeConnections.organizerId, organizerId));
    connectionId = conn.id;
    await db
      .update(schema.challongeConnections)
      .set({
        accessTokenEnc: encryptSecret("access-1", `${organizerId}:access_token`),
        refreshTokenEnc: encryptSecret("refresh-1", `${organizerId}:refresh_token`),
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        status: "connected",
      })
      .where(eq(schema.challongeConnections.id, connectionId));
    tournamentId = await importTournament(organizerId, "18602864");
  });

  afterAll(async () => {
    await db.execute(sql`delete from auth.users where id = ${organizerId}`);
    vi.unstubAllGlobals();
    await db.$client.end();
  });

  describe("judge pad operations", () => {
    it("records battles, snapshots the rules, and ignores replayed ops", async () => {
      const match = await localMatch("A");
      const ops = [add("over", 1), add("spin", 2)];
      const first = await applyBattleOps(organizerId, match.id, ops);
      const replay = await applyBattleOps(organizerId, match.id, ops);
      expect(first!.battles.map((b) => b.kind)).toEqual(["over", "spin"]);
      expect(replay!.battles).toHaveLength(2);
      expect((await localMatch("A")).ruleSnapshot).toMatchObject({ targetPoints: 4, profileName: "First to 4" });
    });

    it("undo voids the battle instead of deleting it", async () => {
      const match = await localMatch("A");
      const [, spin] = (await activeBattles(match.id))!;
      const result = await applyBattleOps(organizerId, match.id, [{ op: "void", opId: randomUUID(), targetOpId: spin.opId }]);
      expect(result!.battles.map((b) => b.kind)).toEqual(["over"]);
      const [row] = await db.select().from(schema.battles).where(eq(schema.battles.opId, spin.opId));
      expect(row).toMatchObject({ voidReason: "undo" });
      expect(row.voidedAt).not.toBeNull();
    });

    it("rejects battles after the match is decided and on matches without both players", async () => {
      const match = await localMatch("A");
      const result = await applyBattleOps(organizerId, match.id, [add("burst", 1), add("spin", 2)]);
      expect(result!.battles.map((b) => b.kind)).toEqual(["over", "burst"]);
      expect(result!.rejected[0].reason).toMatch(/already decided/);

      const pending = await localMatch("I");
      const blocked = await applyBattleOps(organizerId, pending.id, [add("spin", 1)]);
      expect(blocked!.rejected[0].reason).toMatch(/Both players/);
    });

    it("refuses another organizer's match", async () => {
      expect(await applyBattleOps(randomUUID(), (await localMatch("A")).id, [add("spin", 1)])).toBeNull();
      expect(await submitResult(randomUUID(), (await localMatch("A")).id)).toMatchObject({ status: "invalid" });
    });
  });

  describe("reporting", () => {
    it("refuses to send an undecided match", async () => {
      expect(await submitResult(organizerId, (await localMatch("B")).id)).toMatchObject({ status: "invalid" });
    });

    it("sends the result, verifies it, refreshes the bracket and learns where players went (2 requests)", async () => {
      const before = await monthlyUsage(connectionId);
      const outcome = await submitResult(organizerId, (await localMatch("A")).id);

      expect(outcome).toEqual({ status: "synced" });
      expect(fake.state.puts.at(-1)!.entries).toEqual([
        { participant_id: P.a1, score_set: "4", rank: 1, advancing: true },
        { participant_id: P.a2, score_set: "0", rank: 2, advancing: false },
      ]);
      expect(await monthlyUsage(connectionId)).toBe(before + 2);

      const a = await localMatch("A");
      expect(a).toMatchObject({ state: "complete", winnerChallongeId: P.a1, winnerNextChallongeId: (await localMatch("I")).challongeId, loserNextChallongeId: (await localMatch("R")).challongeId });
      expect(await localMatch("I")).toMatchObject({ player1ChallongeId: P.a1 });
      const [outbox] = await db.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.matchId, a.id));
      expect(outbox).toMatchObject({ status: "done", kind: "report_result", createdBy: organizerId });
    });

    it("corrects a winner without confirmation while nothing downstream has been played", async () => {
      await clearBattles("A");
      await scoreTo("A", 2);
      expect(await submitResult(organizerId, (await localMatch("A")).id)).toEqual({ status: "synced" });
      expect(await localMatch("A")).toMatchObject({ winnerChallongeId: P.a2 });
      expect(await localMatch("I")).toMatchObject({ player1ChallongeId: P.a2 });
      expect(await localMatch("R")).toMatchObject({ player1ChallongeId: P.a1 });
    });

    it("asks before a correction that would erase a played match, then voids that match's battles", async () => {
      await scoreTo("B", 1);
      expect(await submitResult(organizerId, (await localMatch("B")).id)).toEqual({ status: "synced" });
      await scoreTo("I", 1); // P.a2 beats P.b1
      expect(await submitResult(organizerId, (await localMatch("I")).id)).toEqual({ status: "synced" });
      const i = await localMatch("I");
      expect(i.state).toBe("complete");

      await clearBattles("A");
      await scoreTo("A", 1);
      const ask = await submitResult(organizerId, (await localMatch("A")).id);
      expect(ask).toEqual({ status: "needs_confirmation", affected: ["Winners R2 · I (4 - 1)"] });
      const aChallongeId = (await localMatch("A")).challongeId;
      expect(fake.state.puts.filter((p) => p.matchId === aChallongeId)).toHaveLength(2);

      const confirmed = await submitResult(organizerId, (await localMatch("A")).id, { confirmDestructive: true });
      expect(confirmed).toEqual({ status: "synced" });
      expect(await localMatch("I")).toMatchObject({ state: "open", winnerChallongeId: null, player1ChallongeId: P.a1, ruleSnapshot: null });
      expect(await activeBattles(i.id)).toEqual([]);
      const voided = await db.select().from(schema.battles).where(eq(schema.battles.matchId, i.id));
      expect(voided.every((b) => b.voidReason === "reset_by_correction")).toBe(true);
    });

    it("records a failed send and succeeds on retry", async () => {
      await scoreTo("C", 1);
      const c = await localMatch("C");
      fake.state.failPut = 500;
      expect(await submitResult(organizerId, c.id)).toMatchObject({ status: "failed" });
      const [failed] = await db.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.matchId, c.id));
      expect(failed).toMatchObject({ status: "failed", attempts: 1 });

      fake.state.failPut = null;
      expect(await submitResult(organizerId, c.id)).toEqual({ status: "synced" });
      const [latest] = await db
        .select()
        .from(schema.syncOutbox)
        .where(eq(schema.syncOutbox.matchId, c.id))
        .orderBy(desc(schema.syncOutbox.createdAt))
        .limit(1);
      expect(latest.status).toBe("done");
    });

    it("flags a conflict when Challonge answers 200 but doesn't apply the result", async () => {
      await scoreTo("D", 2);
      fake.state.ignorePuts = true;
      try {
        const outcome = await submitResult(organizerId, (await localMatch("D")).id);
        expect(outcome).toMatchObject({ status: "conflict" });
        expect((outcome as { error: string }).error).toMatch(/didn't record/);
        expect(await localMatch("D")).toMatchObject({ state: "open" });
      } finally {
        fake.state.ignorePuts = false;
      }
    });
  });
});
