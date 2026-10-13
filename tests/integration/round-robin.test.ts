// A round robin against the real database and a fake Challonge built from spike S7: import,
// results that don't read the bracket again, a correction, a tie entered on challonge.com, finalize.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeRoundRobin } from "./fake-round-robin";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

describe.skipIf(!enabled)("a round robin against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq, and } = await import("drizzle-orm");
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials } = await import("@/lib/challonge/connection");
  const { importTournament, resyncTournament } = await import("@/lib/challonge/sync");
  const { finalizeTournament } = await import("@/lib/challonge/finalize");
  const { monthlyUsage } = await import("@/lib/challonge/budget");
  const { applyBattleOps, activeBattles } = await import("@/lib/battles");
  const { submitResult } = await import("@/lib/challonge/report");
  const { addStadium } = await import("@/lib/venue");
  const { judgeMyself } = await import("@/lib/judges");
  const { buildControlRoom } = await import("@/lib/control-room");

  const fake = createFakeRoundRobin();
  const organizerId = randomUUID();
  let tournamentId: string;
  let connectionId: string;

  const localMatches = () => db.select().from(schema.matches).where(eq(schema.matches.tournamentId, tournamentId));
  const localMatch = async (identifier: string) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.identifier, identifier)))
    )[0];
  const add = (kind: string, side: 1 | 2) => ({ op: "add" as const, opId: randomUUID(), kind: kind as "spin", side });

  /** Scores a match to `winnerSide` 4–1 (Xtreme + Spin vs Spin) via judge-pad ops, starting it first if it was called to a stadium. */
  async function scoreTo(identifier: string, winnerSide: 1 | 2) {
    const match = await localMatch(identifier);
    const loser = winnerSide === 1 ? 2 : 1;
    const start = match.callStatus === "called" ? [{ op: "start" as const, opId: randomUUID() }] : [];
    const applied = await applyBattleOps(organizerId, match.id, [...start, add("xtreme", winnerSide), add("spin", loser), add("spin", winnerSide)]);
    expect(applied!.rejected).toEqual([]);
    return match;
  }

  /** What one step asked Challonge for. */
  async function requestsOf<T>(step: () => Promise<T>): Promise<{ result: T; requests: string[] }> {
    const from = fake.state.requests.length;
    const result = await step();
    return { result, requests: fake.state.requests.slice(from) };
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
  });

  afterAll(async () => {
    await db.execute(sql`delete from auth.users where id = ${organizerId}`);
    vi.unstubAllGlobals();
    await db.$client.end();
  });

  it("imports in 3 requests, with every match open from the start", async () => {
    const { result, requests } = await requestsOf(() => importTournament(organizerId, fake.slug));
    tournamentId = result;
    const [tournament] = await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, tournamentId));
    const rows = await localMatches();
    expect(tournament).toMatchObject({ tournamentType: "round robin", groupStage: false, participantsCount: 4 });
    expect(rows.map((m) => `${m.identifier}:r${m.round}:${m.state}`).sort()).toEqual(["A:r1:open", "B:r1:open", "C:r2:open", "D:r2:open", "E:r3:open", "F:r3:open"]);
    expect(requests).toHaveLength(3);
  });

  it("sends a result in 1 request and doesn't read the bracket again", async () => {
    const usage = await monthlyUsage(connectionId);
    const a = await scoreTo("A", 1);

    const { result, requests } = await requestsOf(() => submitResult(organizerId, a.id));

    expect(result).toEqual({ status: "synced" });
    expect(requests).toEqual([`PUT /tournaments/${fake.id}/matches/${a.challongeId}.json`]);
    expect(await monthlyUsage(connectionId)).toBe(usage + 1);
    expect(await localMatch("A")).toMatchObject({ state: "complete", winnerChallongeId: a.player1ChallongeId, scores: "4 - 1", scoreInSets: [[4, 1]] });
    expect((await localMatches()).filter((m) => m.state === "open")).toHaveLength(5);
  });

  it("a result at a stadium frees it and calls the next match", async () => {
    await addStadium(organizerId, tournamentId);
    const [stadium] = await db.select().from(schema.stadiums).where(eq(schema.stadiums.tournamentId, tournamentId));
    expect(await judgeMyself(organizerId, stadium.id)).toEqual({});
    expect(await localMatch("B")).toMatchObject({ callStatus: "called", stadiumId: stadium.id });

    const b = await scoreTo("B", 1);
    expect(await submitResult(organizerId, b.id)).toEqual({ status: "synced" });

    expect(await localMatch("B")).toMatchObject({ state: "complete", callStatus: "none", stadiumId: null });
    expect(await localMatch("C")).toMatchObject({ callStatus: "called", stadiumId: stadium.id });
  });

  it("a corrected winner needs no confirmation and changes that match only", async () => {
    // C is a later match of one of A's players, already played: in a bracket this would ask first.
    const c = await scoreTo("C", 1);
    expect(await submitResult(organizerId, c.id)).toEqual({ status: "synced" });

    const a = await localMatch("A");
    const battles = await activeBattles(a.id);
    await applyBattleOps(organizerId, a.id, battles.map((b) => ({ op: "void" as const, opId: randomUUID(), targetOpId: b.opId })));
    await scoreTo("A", 2);
    const { result, requests } = await requestsOf(() => submitResult(organizerId, a.id));

    expect(result).toEqual({ status: "synced" });
    expect(requests).toEqual([`PUT /tournaments/${fake.id}/matches/${a.challongeId}.json`]);
    expect(await localMatch("A")).toMatchObject({ state: "complete", winnerChallongeId: a.player2ChallongeId, scores: "1 - 4" });
    expect(await localMatch("C")).toMatchObject({ state: "complete", winnerChallongeId: c.player1ChallongeId, scores: "4 - 1" });
    expect(await activeBattles(c.id)).toHaveLength(3);
  });

  it("doesn't believe a 200 that left the match open, and still asks only once", async () => {
    const d = await scoreTo("D", 1);
    fake.state.ignorePuts = true;
    const { result, requests } = await requestsOf(() => submitResult(organizerId, d.id));
    fake.state.ignorePuts = false;

    expect(result).toMatchObject({ status: "conflict", error: expect.stringMatching(/didn't record this result \(match is open\)/) });
    expect(requests).toHaveLength(1);
    expect((await localMatch("D")).state).toBe("open");

    // Sending it again, once Challonge takes it, is one request too.
    const retry = await requestsOf(() => submitResult(organizerId, d.id));
    expect(retry.result).toEqual({ status: "synced" });
    expect(retry.requests).toHaveLength(1);
    expect((await localMatch("D")).state).toBe("complete");
  });

  it("reads a tie entered on challonge.com as a finished match without a winner", async () => {
    fake.tie("E");
    expect(await resyncTournament(organizerId, tournamentId)).toMatchObject({ matchesChanged: true });
    expect(await localMatch("E")).toMatchObject({ state: "complete", winnerChallongeId: null, scores: "3 - 3", callStatus: "none" });

    const people = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, tournamentId));
    const room = buildControlRoom("round robin", people, await localMatches());
    expect(room.completed.find((m) => m.identifier === "E")).toMatchObject({ winner: null, winnerSlot: null, scores: "3 - 3", roundLabel: "Round 3" });
    // The last round is a round like the others, not a final.
    expect(room.ready.map((m) => `${m.identifier}: ${m.roundLabel}`)).toEqual(["F: Round 3"]);
  });

  it("finalizes after the last match and stores every placement", async () => {
    const f = await scoreTo("F", 1);
    expect(await submitResult(organizerId, f.id)).toEqual({ status: "synced" });
    const usage = await monthlyUsage(connectionId);
    expect(await finalizeTournament(organizerId, tournamentId)).toEqual({ status: "finalized", ranked: 4 });
    // A resync (the tournament, then the matches), the finalize, and the participants.
    expect(await monthlyUsage(connectionId)).toBe(usage + 4);
    const people = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, tournamentId));
    expect(people.map((p) => p.finalRank).sort()).toEqual([1, 2, 3, 4]);
  });
});
