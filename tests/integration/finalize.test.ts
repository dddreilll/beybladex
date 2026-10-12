// M6 against the real database and the fake Challonge: finalizing a tournament and showing the
// standings. The fake's finalize follows Challonge's documentation, not a recorded spike.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeChallonge } from "./fake-challonge";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

describe.skipIf(!enabled)("finalizing against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq, and } = await import("drizzle-orm");
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials } = await import("@/lib/challonge/connection");
  const { importTournament } = await import("@/lib/challonge/sync");
  const { finalizeTournament, loadStandings } = await import("@/lib/challonge/finalize");
  const { monthlyUsage } = await import("@/lib/challonge/budget");
  const { applyBattleOps } = await import("@/lib/battles");
  const { submitResult } = await import("@/lib/challonge/report");
  const { boardSnapshot, boardVersion, playerSnapshot } = await import("@/lib/board");

  const fake = createFakeChallonge();
  const organizerId = randomUUID();
  let tournamentId: string;
  let slug: string;
  let connectionId: string;

  const tournament = async () => (await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, tournamentId)))[0];
  const local = async (identifier: string) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.identifier, identifier)))
    )[0];
  /** Every remaining match gets played on challonge.com, as far as the fake is concerned. */
  const playEverythingOnChallonge = () => {
    for (const m of fake.state.matches.data) m.attributes.state = "complete";
    fake.state.etagVersion++;
  };

  beforeAll(async () => {
    vi.stubGlobal("fetch", fake.fetch);
    await db.execute(sql`insert into auth.users (id, email, aud, role, instance_id)
      values (${organizerId}, ${`it-${organizerId}@example.test`}, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`);
    await saveCredentials(organizerId, "client", "secret");
    await db
      .update(schema.challongeConnections)
      .set({
        accessTokenEnc: encryptSecret("access-1", `${organizerId}:access_token`),
        refreshTokenEnc: encryptSecret("refresh-1", `${organizerId}:refresh_token`),
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        status: "connected",
      })
      .where(eq(schema.challongeConnections.organizerId, organizerId));
    connectionId = (await db.select().from(schema.challongeConnections).where(eq(schema.challongeConnections.organizerId, organizerId)))[0].id;
    tournamentId = await importTournament(organizerId, "18602864");
    slug = (await tournament()).publicSlug;
  });

  afterAll(async () => {
    await db.execute(sql`delete from auth.users where id = ${organizerId}`);
    vi.unstubAllGlobals();
    await db.$client.end();
  });

  it("shows no standings while the tournament is running", async () => {
    expect((await boardSnapshot(slug))!.standings).toBeNull();
    expect(await loadStandings(organizerId, tournamentId)).toEqual({ error: "Standings exist once the tournament is finalized." });
  });

  it("refuses while matches are still to play, without asking Challonge to finalize", async () => {
    const a = await local("A");
    await applyBattleOps(organizerId, a.id, [
      { op: "add", opId: randomUUID(), kind: "xtreme", side: 1 },
      { op: "add", opId: randomUUID(), kind: "spin", side: 1 },
    ]);
    expect(await submitResult(organizerId, a.id)).toEqual({ status: "synced" });

    expect(await finalizeTournament(organizerId, tournamentId)).toEqual({ status: "blocked", error: "7 matches still to play." });
    expect(fake.state.tournamentStateChanges).toEqual([]);
    expect((await tournament()).state).toBe("underway");
  });

  it("refuses while a result hasn't reached Challonge", async () => {
    playEverythingOnChallonge();
    const b = await local("B");
    const [stuck] = await db
      .insert(schema.syncOutbox)
      .values({ tournamentId, matchId: b.id, kind: "report_result", payload: { winnerId: "1", loserId: "2", entries: [] }, status: "failed", createdBy: organizerId })
      .returning();
    expect(await finalizeTournament(organizerId, tournamentId)).toEqual({ status: "blocked", error: "1 result isn't on Challonge yet." });
    expect(fake.state.tournamentStateChanges).toEqual([]);
    await db.delete(schema.syncOutbox).where(eq(schema.syncOutbox.id, stuck.id));
  });

  it("doesn't believe a 200 that left the tournament unfinished", async () => {
    fake.state.ignoreFinalize = true;
    const outcome = await finalizeTournament(organizerId, tournamentId);
    fake.state.ignoreFinalize = false;
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/still "underway" there/) });
    expect((await tournament()).state).toBe("underway");
    expect((await boardSnapshot(slug))!.standings).toBeNull();
  });

  it("passes on Challonge's reason when it refuses", async () => {
    fake.state.refuseFinalize = "Final results are awaiting review";
    const outcome = await finalizeTournament(organizerId, tournamentId);
    fake.state.refuseFinalize = null;
    expect(outcome).toEqual({ status: "failed", error: "Challonge refused to finalize: Final results are awaiting review" });
    expect((await tournament()).state).toBe("underway");
  });

  it("resyncs first, so a match reopened on challonge.com is noticed before asking", async () => {
    const changes = fake.state.tournamentStateChanges.length;
    fake.state.matches.data[5].attributes.state = "open";
    fake.state.etagVersion++;
    expect(await finalizeTournament(organizerId, tournamentId)).toEqual({ status: "blocked", error: "1 match still to play." });
    expect(fake.state.tournamentStateChanges).toHaveLength(changes);
    fake.state.matches.data[5].attributes.state = "complete";
    fake.state.etagVersion++;
  });

  it("finalizes on Challonge in 4 requests and stores every placement", async () => {
    const usage = await monthlyUsage(connectionId);
    const version = (await boardVersion(slug))!;
    const changes = fake.state.tournamentStateChanges.length;

    expect(await finalizeTournament(organizerId, tournamentId)).toEqual({ status: "finalized", ranked: 16 });

    expect(fake.state.tournamentStateChanges.slice(changes)).toEqual(["finalize"]);
    // Resync (tournament + matches), finalize, participants.
    expect(await monthlyUsage(connectionId)).toBe(usage + 4);
    expect((await tournament()).state).toBe("complete");
    expect(await boardVersion(slug)).toBeGreaterThan(version);
  });

  it("puts the standings on the call board, best first, with shared placements", async () => {
    const { standings } = (await boardSnapshot(slug))!;
    expect(standings).toHaveLength(16);
    expect(standings!.slice(0, 4).map((s) => `${s.rank} ${s.name}`)).toEqual(["1 Blader 01", "2 Blader 02", "3 Blader 03", "4 Blader 04"]);
    expect(standings!.filter((s) => s.rank === 5).map((s) => s.name)).toEqual(["Blader 05", "Blader 06"]);
  });

  it("tells each player their own placement", async () => {
    expect((await playerSnapshot(slug, "306531079"))!.status).toEqual({ kind: "finished", rank: 1, of: 16 });
    expect((await playerSnapshot(slug, "306531094"))!.status).toEqual({ kind: "finished", rank: 15, of: 16 });
  });

  it("won't finalize twice, and keeps the players' passcodes through the standings refresh", async () => {
    const before = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, tournamentId));
    expect(await finalizeTournament(organizerId, tournamentId)).toEqual({ status: "blocked", error: "This tournament is already finalized." });
    expect(await loadStandings(organizerId, tournamentId)).toEqual({ ranked: 16 });
    const after = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, tournamentId));
    const codes = (rows: typeof before) => rows.map((r) => `${r.challongeId}:${r.passcode}:${r.signInToken}`).sort();
    expect(codes(after)).toEqual(codes(before));
  });

  it("refuses another organizer", async () => {
    expect(await finalizeTournament(randomUUID(), tournamentId)).toEqual({ status: "failed", error: "Tournament not found." });
    expect(await loadStandings(randomUUID(), tournamentId)).toEqual({ error: "Tournament not found." });
  });
});
