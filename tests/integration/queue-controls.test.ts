// Organizer queue controls against the real database: manual on-deck, recall, back to queue,
// hold and cancel of a match in progress.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PushPayload } from "@/lib/push-endpoint";
import { createOrganizer, enabled, removeOrganizer, seedTournament } from "./helpers";

describe.skipIf(!enabled)("queue controls against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq, and } = await import("drizzle-orm");
  const { applyBattleOps, activeBattles } = await import("@/lib/battles");
  const { boardSnapshot } = await import("@/lib/board");
  const push = await import("@/lib/push");
  const venue = await import("@/lib/venue");
  const judges = await import("@/lib/judges");

  let organizerId: string;
  const stranger = randomUUID();
  let tournamentId: string;
  let slug: string;
  let stadiumId: string;

  const local = async (number: number) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.number, number)))
    )[0];

  /** "M3 called / M1 | M2,M4,M5": now / on deck | first three in the queue */
  async function venueState() {
    const snap = (await boardSnapshot(slug))!;
    const letter = (m: { label: string } | null) => (m ? m.label.split(" · ")[1].replace("Match ", "M") : "-");
    const s = snap.stadiums[0];
    return `${letter(s.now)}${s.now ? ` ${s.now.status}` : ""} / ${letter(s.next)} | ${snap.queue.slice(0, 3).map(letter).join(",")}`;
  }

  const tap = (kind: "spin" | "xtreme", side: 1 | 2) => ({ op: "add" as const, opId: randomUUID(), kind, side });
  /** Recall has a 15 s cooldown; pretend the last call was a while ago. */
  const ageCall = (id: string) => db.update(schema.matches).set({ calledAt: new Date(Date.now() - 60_000) }).where(eq(schema.matches.id, id));

  beforeAll(async () => {
    organizerId = await createOrganizer();
    ({ tournamentId, slug } = await seedTournament(organizerId));
    await venue.updateVenueSettings(organizerId, tournamentId, { autoOnDeck: false, autoCall: false });
    await venue.addStadium(organizerId, tournamentId);
    stadiumId = (await venue.listStadiums(tournamentId))[0].id;
    await judges.judgeMyself(organizerId, stadiumId);
  });

  afterAll(async () => {
    await removeOrganizer(organizerId);
    await db.$client.end();
  });

  describe("manual on-deck", () => {
    it("leaves the stadium empty until the organizer places a match", async () => {
      expect(await venueState()).toBe("- / - | M1,M2,M3");
    });

    it("places the chosen match on deck, not the next in play order", async () => {
      expect(await venue.placeOnDeck(organizerId, (await local(3)).id, stadiumId)).toEqual({});
      expect(await venueState()).toBe("- / M3 | M1,M2,M4");
    });

    it("only fills an empty slot, and refuses held matches and other accounts", async () => {
      const full = await venue.placeOnDeck(organizerId, (await local(4)).id, stadiumId);
      expect(full.error).toMatch(/already has a match on deck/);

      const h = await local(8);
      await venue.setHeld(organizerId, h.id, true);
      await venue.backToQueue(organizerId, (await local(3)).id);
      expect((await venue.placeOnDeck(organizerId, h.id, stadiumId)).error).toMatch(/on hold/);
      expect(await venue.placeOnDeck(stranger, (await local(3)).id, stadiumId)).toEqual({ error: "Match not found." });
      await venue.setHeld(organizerId, h.id, false);
      await venue.placeOnDeck(organizerId, (await local(3)).id, stadiumId);
      expect(await venueState()).toBe("- / M3 | M1,M2,M4");
    });
  });

  describe("recall", () => {
    it("can only recall a match that is called and not yet playing", async () => {
      expect((await venue.recallMatch(organizerId, (await local(3)).id)).error).toMatch(/Only a called match/);
      expect(await venue.callOnDeck(organizerId, stadiumId)).toEqual({});
      expect(await local(3)).toMatchObject({ callStatus: "called", callCount: 1 });
    });

    it("enforces a cooldown right after a call", async () => {
      expect((await venue.recallMatch(organizerId, (await local(3)).id)).error).toMatch(/Wait \d+s/);
    });

    it("re-announces as the second, then third call and keeps the match in place", async () => {
      const c = await local(3);
      const firstCalledAt = c.calledAt!;
      await ageCall(c.id);
      expect(await venue.recallMatch(organizerId, c.id)).toEqual({ callNumber: 2 });

      const again = await local(3);
      expect(again).toMatchObject({ callStatus: "called", callCount: 2, stadiumId });
      // A new call time is what makes boards announce it again.
      expect(again.calledAt!.getTime()).toBeGreaterThanOrEqual(firstCalledAt.getTime());
      expect((await boardSnapshot(slug))!.stadiums[0].now).toMatchObject({ status: "called", callNumber: 2 });

      await ageCall(c.id);
      expect(await venue.recallMatch(organizerId, c.id)).toEqual({ callNumber: 3 });
    });

    it("pushes the repeat call to both players", async () => {
      const c = await local(3);
      const endpoint = `https://fcm.googleapis.com/fcm/send/recall-${organizerId}`;
      await push.savePushSubscription(slug, { playerId: c.player1Id!, subscription: { endpoint, keys: { p256dh: "BObk_abc", auth: "q1w2e3" } } });
      const sent: PushPayload[] = [];
      const result = await push.dispatchRecall(c.id, async (_sub, payload) => {
        sent.push(payload);
        return 201;
      });
      expect(result).toEqual({ sent: 1, removed: 0 });
      expect(sent[0]).toMatchObject({ title: "Third call: Stadium 1", tag: `match-${c.id}` });
    });

    it("refuses another organizer", async () => {
      expect(await venue.recallMatch(stranger, (await local(3)).id)).toEqual({ error: "Match not found." });
    });
  });

  describe("back to queue", () => {
    it("with manual filling, simply empties the on-deck slot", async () => {
      await venue.placeOnDeck(organizerId, (await local(1)).id, stadiumId);
      expect(await venueState()).toBe("M3 called / M1 | M2,M4,M5");
      expect(await venue.backToQueue(organizerId, (await local(1)).id)).toEqual({});
      expect(await venueState()).toBe("M3 called / - | M1,M2,M4");
    });

    it("with automatic filling, skips the returned match once and keeps it first in the queue", async () => {
      await venue.updateVenueSettings(organizerId, tournamentId, { autoOnDeck: true, autoCall: false });
      expect(await venueState()).toBe("M3 called / M1 | M2,M4,M5");
      expect(await venue.backToQueue(organizerId, (await local(1)).id)).toEqual({});
      expect(await venueState()).toBe("M3 called / M2 | M1,M4,M5");
    });

    it("only applies to on-deck matches", async () => {
      expect((await venue.backToQueue(organizerId, (await local(3)).id)).error).toMatch(/Only an on-deck match/);
      expect(await venue.backToQueue(stranger, (await local(2)).id)).toEqual({ error: "Match not found." });
    });
  });

  describe("hold a match in progress", () => {
    it("keeps the battles and frees the stadium", async () => {
      const c = await local(3);
      expect(await venue.startMatch(organizerId, c.id)).toEqual({});
      await applyBattleOps(organizerId, c.id, [tap("xtreme", 1)]);
      expect(await local(3)).toMatchObject({ callStatus: "playing" });

      expect(await venue.holdMatch(organizerId, c.id)).toEqual({});
      expect(await local(3)).toMatchObject({ callStatus: "none", held: true, stadiumId: null, callCount: 0, playingAt: null });
      expect((await activeBattles(c.id)).map((b) => b.kind)).toEqual(["xtreme"]);
      // Auto-call is off, so the on-deck match waits for the organizer.
      expect(await venueState()).toBe("- / M2 | M1,M4,M5");
    });

    it("stays out of the queue until released, then resumes with its battles", async () => {
      const c = await local(3);
      expect((await boardSnapshot(slug))!.queue.some((m) => m.id === c.id)).toBe(false);
      await venue.setHeld(organizerId, c.id, false);
      expect((await boardSnapshot(slug))!.queue.some((m) => m.id === c.id)).toBe(true);
      expect(await activeBattles(c.id)).toHaveLength(1);
    });
  });

  describe("cancel a match in progress", () => {
    it("voids the battles (kept in the log) and holds the match at 0–0", async () => {
      await venue.callOnDeck(organizerId, stadiumId); // B is called
      const b = await local(2);
      await applyBattleOps(organizerId, b.id, [{ op: "start", opId: randomUUID() }, tap("spin", 1), tap("spin", 2)]);
      expect((await local(2)).ruleSnapshot).not.toBeNull();

      expect(await venue.cancelMatch(organizerId, b.id)).toEqual({ voided: 2 });
      expect(await local(2)).toMatchObject({ callStatus: "none", held: true, stadiumId: null, ruleSnapshot: null, callCount: 0 });
      expect(await activeBattles(b.id)).toEqual([]);
      const logged = await db.select().from(schema.battles).where(eq(schema.battles.matchId, b.id));
      expect(logged).toHaveLength(2);
      expect(logged.every((row) => row.voidReason === "cancelled" && row.voidedAt)).toBe(true);
    });

    it("only applies to a match at a stadium, and to its own organizer", async () => {
      expect((await venue.cancelMatch(organizerId, (await local(5)).id)).error).toMatch(/Only a match that is called or being played/);
      expect(await venue.cancelMatch(stranger, (await local(2)).id)).toEqual({ error: "Match not found." });
      expect(await venue.holdMatch(stranger, (await local(2)).id)).toEqual({ error: "Match not found." });
    });
  });

  describe("move an on-deck match to another stadium", () => {
    let second: string;
    const onDeckAt = async (stadium: string) =>
      (await db.select().from(schema.matches).where(and(eq(schema.matches.stadiumId, stadium), eq(schema.matches.callStatus, "on_deck"))))[0];
    const queued = async () =>
      (await db.select().from(schema.matches).where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.callStatus, "none")))).find(
        (m) => m.state === "open" && !m.held && m.player1Id && m.player2Id,
      )!;

    beforeAll(async () => {
      await venue.updateVenueSettings(organizerId, tournamentId, { autoOnDeck: false, autoCall: false });
      await venue.addStadium(organizerId, tournamentId);
      second = (await venue.listStadiums(tournamentId)).find((s) => s.id !== stadiumId)!.id;
      if (!(await onDeckAt(stadiumId))) await venue.placeOnDeck(organizerId, (await queued()).id, stadiumId);
    });

    it("puts it on deck at a stadium with a free slot, and tells its players again where to go", async () => {
      const moving = await onDeckAt(stadiumId);
      // As if its players had been told it is on deck at the first stadium.
      await db.update(schema.matches).set({ notifiedStatus: "on_deck" }).where(eq(schema.matches.id, moving.id));
      expect(await venue.moveOnDeck(organizerId, moving.id, second)).toEqual({});
      expect(await local(moving.number!)).toMatchObject({ stadiumId: second, callStatus: "on_deck", notifiedStatus: null });
      const board = (await boardSnapshot(slug))!;
      expect(board.stadiums.find((s) => s.id === second)!.next?.id).toBe(moving.id);
      expect(board.stadiums.find((s) => s.id === stadiumId)!.next).toBeNull();
    });

    it("refuses a taken slot, its own stadium, a match not on deck, an unknown stadium and other accounts", async () => {
      const moved = await onDeckAt(second);
      expect((await venue.moveOnDeck(organizerId, moved.id, second)).error).toMatch(/already on deck at/);
      await venue.placeOnDeck(organizerId, (await queued()).id, stadiumId);
      expect((await venue.moveOnDeck(organizerId, moved.id, stadiumId)).error).toMatch(/already has a match on deck/);
      expect(await venue.moveOnDeck(organizerId, (await queued()).id, second)).toEqual({ error: "Only an on-deck match can be moved." });
      expect(await venue.moveOnDeck(organizerId, moved.id, randomUUID())).toEqual({ error: "Stadium not found." });
      expect(await venue.moveOnDeck(stranger, moved.id, stadiumId)).toEqual({ error: "Match not found." });
      expect((await onDeckAt(second)).id).toBe(moved.id);
    });
  });
});
