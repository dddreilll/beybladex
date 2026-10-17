// M3 against the real database: stadium queue, calls, holds, the public board snapshot.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganizer, enabled, removeOrganizer, seedTournament } from "./helpers";

describe.skipIf(!enabled)("venue queue against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq, and } = await import("drizzle-orm");
  const { applyBattleOps } = await import("@/lib/battles");
  const { submitResult } = await import("@/lib/tournament/results");
  const { boardSnapshot, boardVersion } = await import("@/lib/board");
  const venue = await import("@/lib/venue");
  const judges = await import("@/lib/judges");

  let organizerId: string;
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
      { op: "start", opId: randomUUID() },
      { op: "add", opId: randomUUID(), kind: "xtreme", side },
      { op: "add", opId: randomUUID(), kind: "spin", side: other },
      { op: "add", opId: randomUUID(), kind: "spin", side },
    ]);
    return submitResult(organizerId, m.id);
  }

  beforeAll(async () => {
    organizerId = await createOrganizer();
    ({ tournamentId, slug } = await seedTournament(organizerId));
  });

  afterAll(async () => {
    await removeOrganizer(organizerId);
    await db.$client.end();
  });

  it("gives every tournament an unguessable public slug", () => {
    expect(slug).toMatch(/^[a-f0-9]{16}$/);
  });

  it("calls a match to each new stadium and puts the next one on deck", async () => {
    expect(await venue.addStadium(organizerId, tournamentId)).toBe(true);
    expect(await venue.addStadium(organizerId, tournamentId)).toBe(true);
    // Matches can only start at a stadium that has a judge; the organizer judges both here.
    for (const stadium of await venue.listStadiums(tournamentId)) expect(await judges.judgeMyself(organizerId, stadium.id)).toEqual({});
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

  it("tells Realtime about every version bump, on the tournament's own public channel", async () => {
    const before = (await boardVersion(slug))!;
    await venue.bumpBoard(db, tournamentId);
    const [message] = await db.execute<{ event: string; payload: { version: number }; private: boolean }>(
      sql`select event, payload, private from realtime.messages where topic = ${`board:${slug}`} order by inserted_at desc limit 1`,
    );
    expect(message).toMatchObject({ event: "changed", payload: { version: before + 1 }, private: false });
  });

  it("locks scoring until the match is started, then shows a live score", async () => {
    const a = await local("A");
    const early = await applyBattleOps(organizerId, a.id, [{ op: "add", opId: randomUUID(), kind: "spin", side: 2 }]);
    expect(early).toMatchObject({ battles: [], rejected: [{ reason: "Start the match before scoring." }] });
    expect(await local("A")).toMatchObject({ callStatus: "called" });

    // Start and the first tap can arrive together, as they do from a pad that was offline.
    const result = await applyBattleOps(organizerId, a.id, [
      { op: "start", opId: randomUUID() },
      { op: "add", opId: randomUUID(), kind: "xtreme", side: 1 },
    ]);
    expect(result).toMatchObject({ rejected: [] });
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
    expect(snap.waiting.map((m) => m.label)).toEqual(["Winners R2 · I", "Losers R1 · M"]);
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
    await venue.updateVenueSettings(organizerId, tournamentId, { autoCall: false });
    expect(await win("E", 1)).toEqual({ status: "synced" });
    expect(await lanes()).toEqual(["Main Stage: - / F"]);

    const [stadium] = await venue.listStadiums(tournamentId);
    expect(await venue.callOnDeck(organizerId, stadium.id)).toEqual({});
    expect(await lanes()).toEqual(["Main Stage: F called / B"]);
    expect(await venue.callOnDeck(organizerId, stadium.id)).toMatchObject({ error: expect.stringMatching(/still has a match/) });
  });

  it("starts a called match from the Desk", async () => {
    const f = await local("F");
    expect(await venue.startMatch(organizerId, f.id)).toEqual({});
    expect(await local("F")).toMatchObject({ callStatus: "playing" });
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
