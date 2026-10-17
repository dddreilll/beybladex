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

  const local = async (number: number) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.number, number)))
    )[0];

  /** "Stadium 1: M1 called / M2" (now / on deck) — a compact picture of the venue. */
  async function lanes() {
    const snap = (await boardSnapshot(slug))!;
    const code = (label: string) => label.split(" · ")[1].replace("Match ", "M");
    return snap.stadiums.map((s) => `${s.name}: ${s.now ? `${code(s.now.label)} ${s.now.status}` : "-"} / ${s.next ? code(s.next.label) : "-"}`);
  }

  async function win(number: number, side: 1 | 2) {
    const m = await local(number);
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
    expect(await lanes()).toEqual(["Stadium 1: M1 called / M2", "Stadium 2: M3 called / M4"]);
    const snap = (await boardSnapshot(slug))!;
    expect(snap.queue.map((m) => m.label)).toEqual(["Winners R1 · Match 5", "Winners R1 · Match 6", "Winners R1 · Match 7", "Winners R1 · Match 8"]);
    expect(snap.stadiums[0].now).toMatchObject({ player1: { name: "Blader 01" }, player2: { name: "Blader 16" } });
    expect(snap.stadiums[0].now!.calledAt).not.toBeNull();
  });

  it("bumps the board version on every change", async () => {
    const before = (await boardVersion(slug))!;
    await venue.renameStadium(organizerId, (await venue.listStadiums(tournamentId))[0].id, "Main Stage");
    expect(await boardVersion(slug)).toBe(before + 1);
    expect((await lanes())[0]).toBe("Main Stage: M1 called / M2");
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
    const a = await local(1);
    const early = await applyBattleOps(organizerId, a.id, [{ op: "add", opId: randomUUID(), kind: "spin", side: 2 }]);
    expect(early).toMatchObject({ battles: [], rejected: [{ reason: "Start the match before scoring." }] });
    expect(await local(1)).toMatchObject({ callStatus: "called" });

    // Start and the first tap can arrive together, as they do from a pad that was offline.
    const result = await applyBattleOps(organizerId, a.id, [
      { op: "start", opId: randomUUID() },
      { op: "add", opId: randomUUID(), kind: "xtreme", side: 1 },
    ]);
    expect(result).toMatchObject({ rejected: [] });
    expect(await local(1)).toMatchObject({ callStatus: "playing" });
    const snap = (await boardSnapshot(slug))!;
    expect(snap.stadiums[0].now).toMatchObject({ status: "playing", liveScore: "3–0", lastBattle: "Blader 01 · Xtreme +3" });
  });

  it("gives the board the round and match name separately, and the round of the latest call", async () => {
    const snap = (await boardSnapshot(slug))!;
    expect(snap.stadiums[0].now).toMatchObject({ round: "Winners R1", matchName: "Match 1" });
    expect(snap.currentRound).toBe("Winners R1");
    // Only matches being scored carry a last battle.
    expect(snap.stadiums[1].now).toMatchObject({ status: "called", liveScore: null, lastBattle: null });
    expect(snap.queue[0].lastBattle).toBeNull();
  });

  it("after a result, frees the stadium, calls the on-deck match and refills on deck", async () => {
    const a = await local(1);
    await applyBattleOps(organizerId, a.id, [{ op: "add", opId: randomUUID(), kind: "spin", side: 1 }]);
    expect(await submitResult(organizerId, a.id)).toEqual({ status: "synced" });
    expect(await lanes()).toEqual(["Main Stage: M2 called / M5", "Stadium 2: M3 called / M4"]);
    const snap = (await boardSnapshot(slug))!;
    expect(snap.waiting.map((m) => m.label)).toEqual(["Winners R2 · Match 9", "Losers R1 · Match 13"]);
  });

  it("a no-show hold sends the match out and calls the next one; release queues it again", async () => {
    const b = await local(2);
    expect(await venue.setHeld(organizerId, b.id, true)).toBe(true);
    expect(await lanes()).toEqual(["Main Stage: M5 called / M6", "Stadium 2: M3 called / M4"]);
    expect((await boardSnapshot(slug))!.queue.map((m) => m.label.split(" · ")[1])).toEqual(["Match 7", "Match 8"]);

    await venue.setHeld(organizerId, b.id, false);
    expect((await boardSnapshot(slug))!.queue.map((m) => m.label.split(" · ")[1])).toEqual(["Match 2", "Match 7", "Match 8"]);
  });

  it("removing a stadium sends its matches back to the queue", async () => {
    const [, second] = await venue.listStadiums(tournamentId);
    await venue.removeStadium(organizerId, second.id);
    expect(await lanes()).toEqual(["Main Stage: M5 called / M6"]);
    expect((await boardSnapshot(slug))!.queue.map((m) => m.label.split(" · ")[1])).toEqual(["Match 2", "Match 3", "Match 4", "Match 7", "Match 8"]);
  });

  it("with auto-call off, waits for the organizer to call the on-deck match", async () => {
    await venue.updateVenueSettings(organizerId, tournamentId, { autoCall: false });
    expect(await win(5, 1)).toEqual({ status: "synced" });
    expect(await lanes()).toEqual(["Main Stage: - / M6"]);

    const [stadium] = await venue.listStadiums(tournamentId);
    expect(await venue.callOnDeck(organizerId, stadium.id)).toEqual({});
    expect(await lanes()).toEqual(["Main Stage: M6 called / M2"]);
    expect(await venue.callOnDeck(organizerId, stadium.id)).toMatchObject({ error: expect.stringMatching(/still has a match/) });
  });

  it("starts a called match from the Desk", async () => {
    const f = await local(6);
    expect(await venue.startMatch(organizerId, f.id)).toEqual({});
    expect(await local(6)).toMatchObject({ callStatus: "playing" });
  });

  it("refuses another organizer", async () => {
    expect(await venue.addStadium(randomUUID(), tournamentId)).toBe(false);
    expect(await venue.setHeld(randomUUID(), (await local(7)).id, true)).toBe(false);
    expect(await venue.startMatch(randomUUID(), (await local(6)).id)).toEqual({ error: "Match not found." });
  });

  it("returns nothing for an unknown slug", async () => {
    expect(await boardSnapshot("0000000000000000")).toBeNull();
    expect(await boardVersion("0000000000000000")).toBeNull();
  });
});
