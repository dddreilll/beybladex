// Judges against the real database: tablets that ask to judge a stadium and are approved by the
// organizer, one judge per stadium, "no judge, no start", and what a judge tablet may touch.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganizer, enabled, removeOrganizer, seedTournament } from "./helpers";

describe.skipIf(!enabled)("judges against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq, and } = await import("drizzle-orm");
  const { applyBattleOps, activeBattles } = await import("@/lib/battles");
  const { boardVersion } = await import("@/lib/board");
  const { accessOverview } = await import("@/lib/access");
  const { slugForShortCode } = await import("@/lib/short-links");
  const venue = await import("@/lib/venue");
  const judges = await import("@/lib/judges");

  let organizerId: string;
  const stranger = randomUUID();
  let tournamentId: string;
  let slug: string;
  let s1: string;
  let s2: string;

  const TABLET = "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const local = async (number: number) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.number, number)))
    )[0];
  const rows = () => db.select().from(schema.judgeScreens).where(eq(schema.judgeScreens.tournamentId, tournamentId));
  const start = () => ({ op: "start" as const, opId: randomUUID() });
  const tap = (kind: "spin" | "xtreme", side: 1 | 2) => ({ op: "add" as const, opId: randomUUID(), kind, side });
  /** A tablet asks for a stadium; returns its cookie and its row id. */
  async function tabletAsks(stadiumId: string) {
    const result = await judges.requestJudgeAccess(slug, undefined, stadiumId, TABLET);
    if (result.status !== "pending" || !result.token) throw new Error(`unexpected ${JSON.stringify(result)}`);
    const row = (await rows()).find((r) => r.pairingCode === result.code)!;
    return { token: result.token, code: result.code, id: row.id };
  }

  beforeAll(async () => {
    organizerId = await createOrganizer();
    tournamentId = (await seedTournament(organizerId)).tournamentId;
    slug = (await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, tournamentId)))[0].publicSlug;
    // Two stadiums: A is called at Stadium 1 (B on deck), C at Stadium 2 (D on deck).
    await venue.addStadium(organizerId, tournamentId);
    await venue.addStadium(organizerId, tournamentId);
    [s1, s2] = (await venue.listStadiums(tournamentId)).map((s) => s.id);
  });

  afterAll(async () => {
    await removeOrganizer(organizerId);
    await db.$client.end();
  });

  describe("short links", () => {
    it("gives every tournament a 6-character code that finds it, typed in any case", async () => {
      const [{ shortCode }] = await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, tournamentId));
      expect(shortCode).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
      expect(await slugForShortCode(shortCode)).toBe(slug);
      expect(await slugForShortCode(` ${shortCode.toLowerCase()} `)).toBe(slug);
    });

    it("finds nothing for a wrong or malformed code", async () => {
      expect(await slugForShortCode("ZZZZZ2")).toBeNull();
      expect(await slugForShortCode("K7M2")).toBeNull();
      expect(await slugForShortCode("'; drop--")).toBeNull();
    });
  });

  describe("no judge, no start", () => {
    it("still calls matches to a stadium that has no judge", async () => {
      expect(await local(1)).toMatchObject({ callStatus: "called", stadiumId: s1 });
      expect(await local(3)).toMatchObject({ callStatus: "called", stadiumId: s2 });
    });

    it("refuses to start from the control room", async () => {
      expect(await venue.startMatch(organizerId, (await local(1)).id)).toMatchObject({ error: expect.stringMatching(/^This stadium has no judge yet\./) });
      expect(await local(1)).toMatchObject({ callStatus: "called" });
    });

    it("refuses to start from a pad, and keeps scoring locked", async () => {
      const a = await local(1);
      const result = await applyBattleOps(organizerId, a.id, [start(), tap("xtreme", 1)]);
      expect(result!.battles).toEqual([]);
      expect(result!.rejected.map((r) => r.reason)).toEqual(["This stadium has no judge yet.", "Start the match before scoring."]);
      expect(await local(1)).toMatchObject({ callStatus: "called" });
    });

    it("leaves a match scored straight from the queue alone: no stadium, no judge needed", async () => {
      const e = await local(5);
      expect(e.callStatus).toBe("none");
      const result = await applyBattleOps(organizerId, e.id, [tap("spin", 1)]);
      expect(result).toMatchObject({ rejected: [] });
      expect(result!.battles).toHaveLength(1);
      // Starting it makes no sense either: it was never called anywhere.
      expect((await applyBattleOps(organizerId, e.id, [start()]))!.rejected[0].reason).toMatch(/hasn't been called/);
    });
  });

  describe("judge tablets", () => {
    let tablet: { token: string; code: string; id: string };

    it("shows the sign-up screen the tournament and its stadiums, nothing else", async () => {
      const info = (await judges.judgeSignUpInfo(slug))!;
      expect(info.stadiums).toEqual([
        { id: s1, name: "Stadium 1", taken: false },
        { id: s2, name: "Stadium 2", taken: false },
      ]);
      expect(JSON.stringify(info)).not.toMatch(/Blader/);
      expect(await judges.judgeSignUpInfo("0000000000000000")).toBeNull();
    });

    it("gives a tablet a pairing code for the stadium it picked, and nothing until approved", async () => {
      const before = (await boardVersion(slug))!;
      tablet = await tabletAsks(s1);
      expect(tablet.code).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
      expect(await judges.judgeAccess(slug, tablet.token)).toEqual({
        status: "pending",
        judgeId: tablet.id,
        // Nobody typed a name, so the judge goes by what the tablet looks like.
        name: "Chrome on Android",
        code: tablet.code,
        stadiumId: s1,
        stadium: "Stadium 1",
      });
      expect(await judges.judgeAccess(slug, undefined)).toEqual({ status: "none" });
      expect(await judges.judgeAccess(slug, "not-a-real-cookie")).toEqual({ status: "none" });
      expect(await boardVersion(slug)).toBe(before + 1);

      const overview = await accessOverview(tournamentId, 1);
      expect(overview.judges).toHaveLength(1);
      expect(overview.judges[0]).toMatchObject({ status: "pending", code: tablet.code, stadium: "Stadium 1", name: "Chrome on Android", device: "Chrome on Android", byOrganizer: false, open: false });
    });

    it("lets a waiting tablet change its stadium without a new code", async () => {
      expect(await judges.requestJudgeAccess(slug, tablet.token, s2, TABLET)).toEqual({ status: "pending", code: tablet.code, stadium: "Stadium 2", name: "Chrome on Android" });
      expect(await judges.requestJudgeAccess(slug, tablet.token, s1, TABLET)).toEqual({ status: "pending", code: tablet.code, stadium: "Stadium 1", name: "Chrome on Android" });
      expect(await rows()).toHaveLength(1);
    });

    it("lets a waiting judge give their name, and keeps it when they only change stadium", async () => {
      const before = (await boardVersion(slug))!;
      expect(await judges.requestJudgeAccess(slug, tablet.token, s1, TABLET, "  Maria   Santos ")).toMatchObject({ status: "pending", code: tablet.code, name: "Maria Santos" });
      // The control room is told, so the request there reads the new name.
      expect(await boardVersion(slug)).toBe(before + 1);
      expect((await accessOverview(tournamentId, 1)).judges[0]).toMatchObject({ name: "Maria Santos", device: "Chrome on Android" });

      expect(await judges.requestJudgeAccess(slug, tablet.token, s2, TABLET)).toMatchObject({ stadium: "Stadium 2", name: "Maria Santos" });
      expect(await judges.requestJudgeAccess(slug, tablet.token, s1, TABLET)).toMatchObject({ stadium: "Stadium 1", name: "Maria Santos" });
      // Clearing the field goes back to the detected device.
      expect(await judges.requestJudgeAccess(slug, tablet.token, s1, TABLET, "   ")).toMatchObject({ name: "Chrome on Android" });
    });

    it("refuses a stadium that doesn't belong to the tournament", async () => {
      expect(await judges.requestJudgeAccess(slug, undefined, randomUUID(), TABLET)).toEqual({ status: "not_found" });
      expect(await judges.requestJudgeAccess("0000000000000000", undefined, s1, TABLET)).toEqual({ status: "not_found" });
    });

    it("only the organizer can approve; then the stadium has its judge", async () => {
      expect(await judges.approveJudge(stranger, tablet.id)).toMatchObject({ error: expect.stringMatching(/no longer waiting/) });
      expect(await venue.stadiumHasJudge(db, s1)).toBe(false);

      expect(await judges.approveJudge(organizerId, tablet.id)).toEqual({});
      expect(await venue.stadiumHasJudge(db, s1)).toBe(true);
      expect(await venue.stadiumHasJudge(db, s2)).toBe(false);
      expect(await judges.judgeAccess(slug, tablet.token)).toMatchObject({ status: "approved", stadiumId: s1, stadium: "Stadium 1", organizerId, tournamentId });
      expect((await judges.judgeSignUpInfo(slug))!.stadiums.map((s) => s.taken)).toEqual([true, false]);
      expect((await accessOverview(tournamentId, 1)).judges[0]).toMatchObject({ status: "approved", open: true, since: "approved just now" });
    });

    it("shows a tablet closed at once when its tab says it is closing; it stays the judge and opens again on its next check", async () => {
      await judges.closeJudgeScreen(slug, tablet.token);
      expect((await accessOverview(tournamentId, 1)).judges[0]).toMatchObject({ status: "approved", open: false, seen: "just now" });
      expect(await venue.stadiumHasJudge(db, s1)).toBe(true);
      expect(await judges.judgeAccess(slug, tablet.token)).toMatchObject({ status: "approved" });
      expect((await accessOverview(tournamentId, 1)).judges[0]).toMatchObject({ open: true });
    });

    it("lets the judge rename themselves after approval", async () => {
      expect(await judges.renameJudgeTablet(slug, tablet.token, "Maria")).toBe("Maria");
      expect(await judges.judgeAccess(slug, tablet.token)).toMatchObject({ status: "approved", name: "Maria" });
      expect((await accessOverview(tournamentId, 1)).judges[0]).toMatchObject({ name: "Maria", device: "Chrome on Android" });
      // A name that is far too long is cut, not refused.
      expect(await judges.renameJudgeTablet(slug, tablet.token, "x".repeat(80))).toHaveLength(30);
      expect(await judges.renameJudgeTablet(slug, "not-a-real-cookie", "Mallory")).toBeNull();
      expect(await judges.renameJudgeTablet(slug, undefined, "Mallory")).toBeNull();
    });

    it("lets the organizer rename a judge, and only the organizer", async () => {
      expect(await judges.renameJudge(stranger, tablet.id, "Mallory")).toEqual({ error: "That judge is no longer here." });
      expect(await judges.renameJudge(organizerId, tablet.id, "Table 1")).toEqual({});
      const access = await judges.judgeAccess(slug, tablet.token);
      if (access.status !== "approved") throw new Error("expected an approved tablet");
      // The tablet's own screen follows.
      expect((await judges.judgeSnapshot(access))!.judge).toBe("Table 1");
      // Blank goes back to the device name here too.
      expect(await judges.renameJudge(organizerId, tablet.id, "")).toEqual({});
      expect(await judges.judgeAccess(slug, tablet.token)).toMatchObject({ name: "Chrome on Android" });
    });

    it("shows the tablet its own stadium only", async () => {
      const access = await judges.judgeAccess(slug, tablet.token);
      if (access.status !== "approved") throw new Error("expected an approved tablet");
      const snapshot = (await judges.judgeSnapshot(access))!;
      expect(snapshot).toMatchObject({
        stadium: "Stadium 1",
        now: { id: (await local(1)).id, players: "Blader 01 vs Blader 16", status: "called", label: "Winners R1 · Match 1" },
        next: { players: "Blader 08 vs Blader 09" },
      });
      // Stadium 2's match (C) is none of this tablet's business.
      expect(JSON.stringify(snapshot)).not.toMatch(/Blader 0[45]|Blader 1[23]/);
    });

    it("lets the judge start and score the match at their stadium", async () => {
      const a = await local(1);
      const result = await applyBattleOps(organizerId, a.id, [start(), tap("xtreme", 1)], { judgeStadiumId: s1 });
      expect(result).toMatchObject({ rejected: [] });
      expect(result!.battles).toHaveLength(1);
      expect(await local(1)).toMatchObject({ callStatus: "playing" });
      // Pressing Start again (a resend) changes nothing.
      expect((await applyBattleOps(organizerId, a.id, [start()], { judgeStadiumId: s1 }))!.rejected).toEqual([]);
    });

    it("keeps a judge away from every other match", async () => {
      // Another stadium's match, their own on-deck match, and a match in the queue.
      for (const number of [3, 2, 6]) {
        expect(await applyBattleOps(organizerId, (await local(number)).id, [start(), tap("spin", 1)], { judgeStadiumId: s1 })).toBeNull();
      }
      expect(await local(3)).toMatchObject({ callStatus: "called" });
    });

    it("allows one judge per stadium", async () => {
      const second = await tabletAsks(s1);
      expect(await judges.approveJudge(organizerId, second.id)).toEqual({ error: "Stadium 1 already has a judge. Disconnect that one first." });
      expect(await judges.judgeMyself(organizerId, s1)).toEqual({ error: "Stadium 1 already has a judge. Disconnect that one first." });
      expect(await judges.judgeAccess(slug, second.token)).toMatchObject({ status: "pending" });
      expect(await judges.removeJudge(organizerId, second.id)).toBe(true);
      expect(await judges.judgeAccess(slug, second.token)).toEqual({ status: "none" });
    });

    it("disconnecting stops the tablet at once; the match being played carries on", async () => {
      expect(await judges.removeJudge(stranger, tablet.id)).toBe(false);
      expect(await judges.removeJudge(organizerId, tablet.id)).toBe(true);
      expect(await judges.judgeAccess(slug, tablet.token)).toEqual({ status: "none" });
      expect(await venue.stadiumHasJudge(db, s1)).toBe(false);
      expect(await local(1)).toMatchObject({ callStatus: "playing" });
      // The organizer can still score it themselves.
      expect((await applyBattleOps(organizerId, (await local(1)).id, [tap("spin", 2)]))!.rejected).toEqual([]);
    });
  });

  describe("judge here myself", () => {
    it("makes the organizer the stadium's judge, which unlocks Start", async () => {
      expect(await judges.judgeMyself(stranger, s2)).toEqual({ error: "Stadium not found." });
      expect(await judges.judgeMyself(organizerId, s2)).toEqual({});
      expect(await venue.stadiumHasJudge(db, s2)).toBe(true);
      const mine = (await accessOverview(tournamentId, 1)).judges.find((j) => j.stadiumId === s2);
      expect(mine).toMatchObject({ byOrganizer: true, status: "approved", code: null, open: true });
      expect(await judges.renameJudge(organizerId, mine!.id, "Someone else")).toEqual({ error: "You are judging this stadium yourself." });

      expect(await venue.startMatch(organizerId, (await local(3)).id)).toEqual({});
      expect(await local(3)).toMatchObject({ callStatus: "playing" });
    });

    it("takes the stadium's one place: a tablet can't be approved until the organizer steps down", async () => {
      const tablet = await tabletAsks(s2);
      expect(await judges.approveJudge(organizerId, tablet.id)).toMatchObject({ error: expect.stringMatching(/Stadium 2 already has a judge/) });

      const mine = (await rows()).find((r) => r.stadiumId === s2 && r.byOrganizer)!;
      expect(await judges.removeJudge(organizerId, mine.id)).toBe(true);
      expect(await judges.approveJudge(organizerId, tablet.id)).toEqual({});
      expect(await judges.judgeAccess(slug, tablet.token)).toMatchObject({ status: "approved", stadiumId: s2 });
    });

    it("removing a stadium removes its judge", async () => {
      await venue.removeStadium(organizerId, s2);
      expect((await rows()).filter((r) => r.stadiumId === s2)).toHaveLength(0);
    });
  });

  describe("a judge leaves, another takes over", () => {
    // Stadium 1 has no judge at this point; match A is being played there with two battles.
    let first: { token: string; code: string; id: string };

    it("leaving removes only the judge: the match keeps its status and every battle", async () => {
      first = await tabletAsks(s1);
      expect(await judges.approveJudge(organizerId, first.id)).toEqual({});
      const a = await local(1);
      // 3–1 so far; this makes it 3–2, still undecided.
      expect((await applyBattleOps(organizerId, a.id, [tap("spin", 2)], { judgeStadiumId: s1 }))!.rejected).toEqual([]);
      const battles = await activeBattles(a.id);
      expect(battles.map((b) => b.kind)).toEqual(["xtreme", "spin", "spin"]);
      const version = (await boardVersion(slug))!;

      expect(await judges.leaveStadium(slug, first.token)).toEqual({ stadium: "Stadium 1" });

      expect(await judges.judgeAccess(slug, first.token)).toEqual({ status: "none" });
      expect(await venue.stadiumHasJudge(db, s1)).toBe(false);
      expect((await rows()).some((r) => r.id === first.id)).toBe(false);
      // The control room is told at once.
      expect(await boardVersion(slug)).toBe(version + 1);
      expect(await activeBattles(a.id)).toEqual(battles);
      expect(await local(1)).toMatchObject({ callStatus: "playing", stadiumId: s1, state: "open", ruleSnapshot: a.ruleSnapshot });
    });

    it("the judge who left can no longer score", async () => {
      expect(await judges.leaveStadium(slug, first.token)).toBeNull();
      expect(await judges.renameJudgeTablet(slug, first.token, "Still here")).toBeNull();
    });

    it("the next judge carries on from the same score, without starting the match again", async () => {
      const a = await local(1);
      const before = await activeBattles(a.id);
      const second = await tabletAsks(s1);
      expect(await judges.approveJudge(organizerId, second.id)).toEqual({});

      const access = await judges.judgeAccess(slug, second.token);
      if (access.status !== "approved") throw new Error("expected an approved judge");
      expect((await judges.judgeSnapshot(access))!.now).toMatchObject({ id: a.id, status: "playing" });

      const result = await applyBattleOps(organizerId, a.id, [tap("spin", 2)], { judgeStadiumId: s1 });
      expect(result!.rejected).toEqual([]);
      expect(result!.battles.slice(0, before.length)).toEqual(before);
      expect(result!.battles).toHaveLength(before.length + 1);
      expect(await local(1)).toMatchObject({ callStatus: "playing" });
      expect(await judges.leaveStadium(slug, second.token)).toEqual({ stadium: "Stadium 1" });
    });

    it("a called match that loses its judge is still called, and can't start until there is one again", async () => {
      // Finish nothing: put a fresh called match at a new stadium with a judge, then have the judge leave.
      await venue.addStadium(organizerId, tournamentId);
      const s3 = (await venue.listStadiums(tournamentId)).at(-1)!.id;
      const called = (await db.select().from(schema.matches).where(and(eq(schema.matches.stadiumId, s3), eq(schema.matches.callStatus, "called"))))[0];
      const judge = await tabletAsks(s3);
      await judges.approveJudge(organizerId, judge.id);
      expect(await judges.leaveStadium(slug, judge.token)).toMatchObject({ stadium: expect.stringMatching(/^Stadium/) });

      expect((await db.select().from(schema.matches).where(eq(schema.matches.id, called.id)))[0]).toMatchObject({ callStatus: "called", stadiumId: s3 });
      expect(await venue.startMatch(organizerId, called.id)).toMatchObject({ error: expect.stringMatching(/^This stadium has no judge yet\. Approve a judge's device/) });
      await venue.removeStadium(organizerId, s3);
    });

    it("a device still waiting for approval can withdraw its request the same way", async () => {
      const waiting = await tabletAsks(s1);
      expect(await judges.leaveStadium(slug, waiting.token)).toEqual({ stadium: "Stadium 1" });
      expect((await rows()).some((r) => r.id === waiting.id)).toBe(false);
    });

    it("an unknown cookie removes nobody", async () => {
      const before = (await rows()).length;
      expect(await judges.leaveStadium(slug, "not-a-real-cookie")).toBeNull();
      expect(await judges.leaveStadium(slug, undefined)).toBeNull();
      expect(await judges.leaveStadium("0000000000000000", first.token)).toBeNull();
      expect(await rows()).toHaveLength(before);
    });
  });

  describe("requests nobody answers", () => {
    it("expire, and are capped so the public page can't flood the control room", async () => {
      const old = await tabletAsks(s1);
      await db.update(schema.judgeScreens).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.judgeScreens.id, old.id));
      expect((await accessOverview(tournamentId, 1)).judges.filter((j) => j.status === "pending")).toHaveLength(0);
      expect(await judges.judgeAccess(slug, old.token)).toEqual({ status: "none" });

      for (let i = 0; i < 8; i++) await tabletAsks(s1);
      expect(await judges.requestJudgeAccess(slug, undefined, s1, TABLET)).toEqual({ status: "busy" });
    });
  });
});
