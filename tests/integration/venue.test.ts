// M3 against the real database: stadium queue, calls, holds, the public board snapshot.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeChallonge } from "./fake-challonge";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

describe.skipIf(!enabled)("venue queue against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq, and } = await import("drizzle-orm");
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials } = await import("@/lib/challonge/connection");
  const { importTournament } = await import("@/lib/challonge/sync");
  const { applyBattleOps } = await import("@/lib/battles");
  const { submitResult } = await import("@/lib/challonge/report");
  const { boardSnapshot, boardVersion } = await import("@/lib/board");
  const venue = await import("@/lib/venue");
  const { monthlyUsage } = await import("@/lib/challonge/budget");

  const fake = createFakeChallonge();
  const organizerId = randomUUID();
  let tournamentId: string;
  let slug: string;

  const local = async (identifier: string) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.identifier, identifier)))
    )[0];

  /** "s1: A called, B on deck | s2: …" — a compact picture of the venue. */
  async function lanes() {
    const snap = (await boardSnapshot(slug))!;
    return snap.stadiums.map((s) => `${s.name}: ${s.now ? `${s.now.label.split(" · ")[1]} ${s.now.status}` : "-"} / ${s.next ? s.next.label.split(" · ")[1] : "-"}`);
  }

  async function win(identifier: string, side: 1 | 2) {
    const m = await local(identifier);
    const other = side === 1 ? 2 : 1;
    await applyBattleOps(organizerId, m.id, [
      { op: "add", opId: randomUUID(), kind: "xtreme", side },
      { op: "add", opId: randomUUID(), kind: "spin", side: other },
      { op: "add", opId: randomUUID(), kind: "spin", side },
    ]);
    return submitResult(organizerId, m.id);
  }

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
    tournamentId = await importTournament(organizerId, "18602864");
    slug = (await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, tournamentId)))[0].publicSlug;
  });

  afterAll(async () => {
    await db.execute(sql`delete from auth.users where id = ${organizerId}`);
    vi.unstubAllGlobals();
    await db.$client.end();
  });

  it("gives every tournament an unguessable public slug", () => {
    expect(slug).toMatch(/^[a-f0-9]{16}$/);
  });

  it("calls a match to each new stadium and puts the next one on deck", async () => {
    expect(await venue.addStadium(organizerId, tournamentId)).toBe(true);
    expect(await venue.addStadium(organizerId, tournamentId)).toBe(true);
    expect(await lanes()).toEqual(["Stadium 1: A called / B", "Stadium 2: C called / D"]);
    const snap = (await boardSnapshot(slug))!;
    expect(snap.queue.map((m) => m.label)).toEqual(["Winners R1 · E", "Winners R1 · F", "Winners R1 · G", "Winners R1 · H"]);
    expect(snap.stadiums[0].now).toMatchObject({ player1: { name: "Blader 01" }, player2: { name: "Blader 16" } });
    expect(snap.stadiums[0].now!.calledAt).not.toBeNull();
  });

  it("bumps the board version on every change", async () => {
    const before = (await boardVersion(slug))!;
    await venue.renameStadium(organizerId, (await venue.listStadiums(tournamentId))[0].id, "Main Stage");
    expect(await boardVersion(slug)).toBe(before + 1);
    expect((await lanes())[0]).toBe("Main Stage: A called / B");
  });

  it("marks a called match as playing on the first judge tap and shows a live score", async () => {
    const a = await local("A");
    await applyBattleOps(organizerId, a.id, [{ op: "add", opId: randomUUID(), kind: "xtreme", side: 1 }]);
    expect(await local("A")).toMatchObject({ callStatus: "playing" });
    const snap = (await boardSnapshot(slug))!;
    expect(snap.stadiums[0].now).toMatchObject({ status: "playing", liveScore: "3–0", lastBattle: "Blader 01 · Xtreme +3" });
  });

  it("gives the board the round and match name separately, and the round of the latest call", async () => {
    const snap = (await boardSnapshot(slug))!;
    expect(snap.stadiums[0].now).toMatchObject({ round: "Winners R1", matchName: "Match 1 · A" });
    expect(snap.currentRound).toBe("Winners R1");
    // Only matches being scored carry a last battle.
    expect(snap.stadiums[1].now).toMatchObject({ status: "called", liveScore: null, lastBattle: null });
    expect(snap.queue[0].lastBattle).toBeNull();
  });

  it("after a result, frees the stadium, calls the on-deck match and refills on deck", async () => {
    const a = await local("A");
    await applyBattleOps(organizerId, a.id, [{ op: "add", opId: randomUUID(), kind: "spin", side: 1 }]);
    expect(await submitResult(organizerId, a.id)).toEqual({ status: "synced" });
    expect(await lanes()).toEqual(["Main Stage: B called / E", "Stadium 2: C called / D"]);
    const snap = (await boardSnapshot(slug))!;
    expect(snap.waiting.map((m) => m.label)).toEqual(["Losers R1 · R", "Winners R2 · I"]);
  });

  it("a no-show hold sends the match out and calls the next one; release queues it again", async () => {
    const b = await local("B");
    expect(await venue.setHeld(organizerId, b.id, true)).toBe(true);
    expect(await lanes()).toEqual(["Main Stage: E called / F", "Stadium 2: C called / D"]);
    expect((await boardSnapshot(slug))!.queue.map((m) => m.label.split(" · ")[1])).toEqual(["G", "H"]);

    await venue.setHeld(organizerId, b.id, false);
    expect((await boardSnapshot(slug))!.queue.map((m) => m.label.split(" · ")[1])).toEqual(["B", "G", "H"]);
  });

  it("removing a stadium sends its matches back to the queue", async () => {
    const [, second] = await venue.listStadiums(tournamentId);
    await venue.removeStadium(organizerId, second.id);
    expect(await lanes()).toEqual(["Main Stage: E called / F"]);
    expect((await boardSnapshot(slug))!.queue.map((m) => m.label.split(" · ")[1])).toEqual(["B", "C", "D", "G", "H"]);
  });

  it("with auto-call off, waits for the organizer to call the on-deck match", async () => {
    await venue.updateVenueSettings(organizerId, tournamentId, { autoCall: false, markUnderway: false });
    expect(await win("E", 1)).toEqual({ status: "synced" });
    expect(await lanes()).toEqual(["Main Stage: - / F"]);

    const [stadium] = await venue.listStadiums(tournamentId);
    expect(await venue.callOnDeck(organizerId, stadium.id)).toEqual({});
    expect(await lanes()).toEqual(["Main Stage: F called / B"]);
    expect(await venue.callOnDeck(organizerId, stadium.id)).toMatchObject({ error: expect.stringMatching(/still has a match/) });
  });

  it("start marks the match underway on Challonge only when enabled (1 request)", async () => {
    const f = await local("F");
    const usage = await monthlyUsage((await db.select().from(schema.challongeConnections).where(eq(schema.challongeConnections.organizerId, organizerId)))[0].id);
    await venue.updateVenueSettings(organizerId, tournamentId, { autoCall: true, markUnderway: true });
    expect(await venue.startMatch(organizerId, f.id)).toEqual({});
    expect(await local("F")).toMatchObject({ callStatus: "playing" });
    expect(fake.state.stateChanges.at(-1)).toEqual({ matchId: f.challongeId, state: "mark_as_underway" });
    const conn = (await db.select().from(schema.challongeConnections).where(eq(schema.challongeConnections.organizerId, organizerId)))[0];
    expect(await monthlyUsage(conn.id)).toBe(usage + 1);
  });

  it("refuses another organizer", async () => {
    expect(await venue.addStadium(randomUUID(), tournamentId)).toBe(false);
    expect(await venue.setHeld(randomUUID(), (await local("G")).id, true)).toBe(false);
    expect(await venue.startMatch(randomUUID(), (await local("F")).id)).toEqual({ error: "Match not found." });
  });

  it("returns nothing for an unknown slug", async () => {
    expect(await boardSnapshot("0000000000000000")).toBeNull();
    expect(await boardVersion("0000000000000000")).toBeNull();
  });
});
