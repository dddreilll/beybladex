// M6 against the real database: call board screens the organizer approves (up to a limit), and
// player sign-in with a passcode on one device at a time.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeChallonge } from "./fake-challonge";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

describe.skipIf(!enabled)("screen and player access against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq, and } = await import("drizzle-orm");
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials } = await import("@/lib/challonge/connection");
  const { importTournament } = await import("@/lib/challonge/sync");
  const { boardVersion, playerSnapshot, signInInfo } = await import("@/lib/board");
  const push = await import("@/lib/push");
  const venue = await import("@/lib/venue");
  const access = await import("@/lib/access");

  const fake = createFakeChallonge();
  const organizerId = randomUUID();
  const stranger = randomUUID();
  let tournamentId: string;
  let slug: string;

  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  // Blader 01 and Blader 16 play match A; Blader 08 plays match B.
  const P = { a1: "306531079", a2: "306531094", b1: "306531086" };

  const screens = () => db.select().from(schema.boardScreens).where(eq(schema.boardScreens.tournamentId, tournamentId));
  const player = async (id: string) =>
    (await db.select().from(schema.participants).where(and(eq(schema.participants.tournamentId, tournamentId), eq(schema.participants.challongeId, id))))[0];
  const wrongCode = (right: string) => (right === "0000" ? "0001" : "0000");
  const from = (network: string, extra: { currentToken?: string; userAgent?: string } = {}) => ({ network, userAgent: IPHONE, ...extra });
  const subscription = (name: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}-${organizerId}`, keys: { p256dh: "BObk_abc", auth: "q1w2e3" } });
  const subscriptionsOf = (id: string) =>
    db
      .select()
      .from(schema.pushSubscriptions)
      .where(and(eq(schema.pushSubscriptions.tournamentId, tournamentId), eq(schema.pushSubscriptions.participantChallongeId, id)));

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

  describe("call board screens", () => {
    let first: { id: string; token: string; code: string };
    let second: { id: string; token: string };

    it("gives a new screen a pairing code, and no board until it is approved", async () => {
      const before = (await boardVersion(slug))!;
      const result = await access.requestBoardAccess(slug, undefined, CHROME);
      if (result.status !== "pending" || !result.token) throw new Error(`unexpected ${JSON.stringify(result)}`);
      expect(result.code).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);

      const [row] = await screens();
      first = { id: row.id, token: result.token, code: result.code };
      expect(row).toMatchObject({ status: "pending", pairingCode: result.code, device: "Chrome on Windows" });
      // The cookie itself is never stored.
      expect(row.tokenHash).not.toBe(result.token);

      expect(await access.boardAccess(slug, result.token)).toEqual({ status: "pending", code: result.code });
      expect(await access.boardAccess(slug, undefined)).toEqual({ status: "none" });
      expect(await access.boardAccess(slug, "not-a-real-cookie")).toEqual({ status: "none" });
      // The control room is told at once, through the board version.
      expect(await boardVersion(slug)).toBe(before + 1);
    });

    it("keeps the same code when the same screen asks again", async () => {
      expect(await access.requestBoardAccess(slug, first.token, CHROME)).toEqual({ status: "pending", code: first.code });
      expect(await screens()).toHaveLength(1);
    });

    it("only the tournament's organizer can approve", async () => {
      expect(await access.approveBoardScreen(stranger, first.id)).toMatchObject({ error: expect.stringMatching(/no longer waiting/) });
      expect(await access.boardAccess(slug, first.token)).toMatchObject({ status: "pending" });
    });

    it("an approved screen gets the board and counts as open", async () => {
      expect(await access.approveBoardScreen(organizerId, first.id)).toEqual({});
      expect(await access.boardAccess(slug, first.token)).toEqual({ status: "approved", version: await boardVersion(slug) });
      expect(await access.requestBoardAccess(slug, first.token, CHROME)).toEqual({ status: "approved" });

      const overview = await access.accessOverview(tournamentId, 1);
      expect(overview.boards).toHaveLength(1);
      expect(overview.boards[0]).toMatchObject({ status: "approved", open: true, device: "Chrome on Windows", since: "approved just now" });
    });

    it("refuses a screen beyond the limit until the limit is raised", async () => {
      const result = await access.requestBoardAccess(slug, undefined, IPHONE);
      if (result.status !== "pending" || !result.token) throw new Error("expected a pending request");
      expect(result.code).not.toBe(first.code);
      const row = (await screens()).find((s) => s.status === "pending")!;
      second = { id: row.id, token: result.token };

      expect(await access.approveBoardScreen(organizerId, second.id)).toMatchObject({ error: expect.stringMatching(/limit is 1 board\. Disconnect one first/) });
      expect(await access.boardAccess(slug, second.token)).toMatchObject({ status: "pending" });

      await venue.updateVenueSettings(organizerId, tournamentId, { autoCall: true, markUnderway: false, boardLimit: 2 });
      expect(await access.approveBoardScreen(organizerId, second.id)).toEqual({});
      expect(await access.boardAccess(slug, second.token)).toMatchObject({ status: "approved" });
      expect((await access.accessOverview(tournamentId, 2)).boards.map((b) => b.status)).toEqual(["approved", "approved"]);
    });

    it("shows a screen that stopped checking in as not open, and keeps its place", async () => {
      await db.update(schema.boardScreens).set({ lastSeenAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.boardScreens.id, second.id));
      const overview = await access.accessOverview(tournamentId, 2);
      expect(overview.boards.find((b) => b.id === second.id)).toMatchObject({ status: "approved", open: false, seen: "10 minutes ago" });
      // Checking in again marks it open.
      await access.boardAccess(slug, second.token);
      expect((await access.accessOverview(tournamentId, 2)).boards.find((b) => b.id === second.id)).toMatchObject({ open: true });
    });

    it("shows a screen closed at once when its tab says it is closing, and open again when it checks in", async () => {
      await access.closeBoardScreen(slug, second.token);
      expect((await access.accessOverview(tournamentId, 2)).boards.find((b) => b.id === second.id)).toMatchObject({ open: false, seen: "just now" });
      // Another screen's cookie, or another tournament, closes nothing.
      await access.closeBoardScreen("0000000000000000", first.token);
      await access.closeBoardScreen(slug, "not-a-real-cookie");
      expect((await access.accessOverview(tournamentId, 2)).boards.find((b) => b.id === first.id)).toMatchObject({ open: true });
      // It is still approved: reopening the tab, or a reload, opens it again with its first check.
      expect(await access.boardAccess(slug, second.token)).toMatchObject({ status: "approved" });
      expect((await access.accessOverview(tournamentId, 2)).boards.find((b) => b.id === second.id)).toMatchObject({ open: true });
    });

    it("disconnecting stops the screen's cookie at once", async () => {
      expect(await access.removeBoardScreen(stranger, second.id)).toBe(false);
      const before = (await boardVersion(slug))!;
      expect(await access.removeBoardScreen(organizerId, second.id)).toBe(true);
      expect(await access.boardAccess(slug, second.token)).toEqual({ status: "none" });
      // Connected boards are nudged to check in, which is how the removed one finds out.
      expect(await boardVersion(slug)).toBe(before + 1);
      expect(await access.boardAccess(slug, first.token)).toMatchObject({ status: "approved" });
    });

    it("drops a request nobody answered", async () => {
      const result = await access.requestBoardAccess(slug, undefined, CHROME);
      if (result.status !== "pending" || !result.token) throw new Error("expected a pending request");
      await db
        .update(schema.boardScreens)
        .set({ createdAt: new Date(Date.now() - 20 * 60_000) })
        .where(and(eq(schema.boardScreens.tournamentId, tournamentId), eq(schema.boardScreens.status, "pending")));
      expect((await access.accessOverview(tournamentId, 2)).boards.filter((b) => b.status === "pending")).toHaveLength(0);
      expect(await access.boardAccess(slug, result.token)).toEqual({ status: "none" });
      expect((await screens()).filter((s) => s.status === "pending")).toHaveLength(0);
    });

    it("caps unanswered requests so the public page can't flood the control room", async () => {
      const codes = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const result = await access.requestBoardAccess(slug, undefined, CHROME);
        if (result.status !== "pending") throw new Error("expected a pending request");
        codes.add(result.code);
      }
      expect(codes.size).toBe(8);
      expect(await access.requestBoardAccess(slug, undefined, CHROME)).toEqual({ status: "busy" });
      await db.delete(schema.boardScreens).where(and(eq(schema.boardScreens.tournamentId, tournamentId), eq(schema.boardScreens.status, "pending")));
    });

    it("answers nothing useful for an unknown tournament", async () => {
      expect(await access.requestBoardAccess("0000000000000000", undefined, CHROME)).toEqual({ status: "not_found" });
      expect(await access.boardAccess("0000000000000000", first.token)).toEqual({ status: "none" });
    });
  });

  describe("player sign-in", () => {
    let phone: string;
    let tablet: string;

    it("gives every imported player a 4-digit passcode and a QR secret", async () => {
      const rows = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, tournamentId));
      expect(rows).toHaveLength(16);
      expect(rows.every((r) => /^\d{4}$/.test(r.passcode) && /^[a-f0-9]{32}$/.test(r.signInToken))).toBe(true);
      expect(new Set(rows.map((r) => r.signInToken)).size).toBe(16);
    });

    it("the sign-in screen gets names only", async () => {
      const info = (await signInInfo(slug))!;
      expect(info.players).toHaveLength(16);
      expect(info.players[0]).toEqual({ id: P.a1, name: "Blader 01" });
      expect(JSON.stringify(info)).not.toMatch(/passcode|signInToken|Stadium/);
    });

    it("refuses a wrong passcode", async () => {
      const { passcode } = await player(P.a1);
      expect(await access.signInPlayer(slug, { playerId: P.a1, code: wrongCode(passcode) }, from("venue"))).toEqual({ status: "wrong" });
      expect(await db.select().from(schema.playerSessions).where(eq(schema.playerSessions.tournamentId, tournamentId))).toHaveLength(0);
    });

    it("signs a player in with their passcode", async () => {
      const { passcode } = await player(P.a1);
      const result = await access.signInPlayer(slug, { playerId: P.a1, code: passcode }, from("venue"));
      if (result.status !== "ok" || !result.token) throw new Error(`unexpected ${JSON.stringify(result)}`);
      phone = result.token;
      expect(await access.playerAccess(slug, phone)).toEqual({ status: "signed_in", playerId: P.a1, version: await boardVersion(slug) });
      expect(await access.playerAccess(slug, undefined)).toEqual({ status: "none" });
      expect(await access.playerAccess(slug, "not-a-real-cookie")).toEqual({ status: "none" });
    });

    it("sends a signed-in player their own match and nobody else's", async () => {
      const snapshot = (await playerSnapshot(slug, P.a1))!;
      expect(snapshot.me).toEqual({ id: P.a1, name: "Blader 01" });
      expect(snapshot.status).toMatchObject({ kind: "queued", position: 1, match: { opponent: "Blader 16" } });
      const text = JSON.stringify(snapshot);
      for (const other of ["Blader 08", "Blader 09", "Blader 02"]) expect(text).not.toContain(other);
      expect(await playerSnapshot(slug, "999")).toBeNull();
    });

    it("signing in again on the same device keeps its session", async () => {
      const { passcode } = await player(P.a1);
      expect(await access.signInPlayer(slug, { playerId: P.a1, code: passcode }, from("venue", { currentToken: phone }))).toEqual({
        status: "ok",
        playerId: P.a1,
        token: null,
      });
      expect(await access.playerAccess(slug, phone)).toMatchObject({ status: "signed_in" });
    });

    it("a second device takes over: the first is signed out and loses its notifications", async () => {
      await push.savePushSubscription(slug, { playerId: P.a1, subscription: subscription("phone") });
      expect(await subscriptionsOf(P.a1)).toHaveLength(1);

      const { passcode } = await player(P.a1);
      const result = await access.signInPlayer(slug, { playerId: P.a1, code: passcode }, from("venue", { userAgent: CHROME }));
      if (result.status !== "ok" || !result.token) throw new Error("expected a new session");
      tablet = result.token;

      expect(await access.playerAccess(slug, tablet)).toMatchObject({ status: "signed_in", playerId: P.a1 });
      // The old phone is told why, so it can say "you signed in on another device".
      expect(await access.playerAccess(slug, phone)).toEqual({ status: "replaced" });
      expect(await subscriptionsOf(P.a1)).toHaveLength(0);

      const rows = await db.select().from(schema.playerSessions).where(eq(schema.playerSessions.participantChallongeId, P.a1));
      expect(rows.filter((r) => r.tournamentId === tournamentId)).toHaveLength(1);
      expect((await access.accessOverview(tournamentId, 2)).players[P.a1]).toMatchObject({ device: "Chrome on Windows", open: true });
    });

    it("the personal QR code signs in without typing", async () => {
      const { signInToken } = await player(P.a2);
      const result = await access.signInPlayer(slug, { token: signInToken }, from("venue"));
      expect(result).toMatchObject({ status: "ok", playerId: P.a2 });
      expect(await access.signInPlayer(slug, { token: "0".repeat(32) }, from("venue"))).toEqual({ status: "wrong" });
      // One player's session doesn't touch another's.
      expect(await access.playerAccess(slug, tablet)).toMatchObject({ status: "signed_in", playerId: P.a1 });
    });

    it("shows a Pass closed at once when its tab says it is closing, and keeps the player signed in", async () => {
      await access.closePlayerSession(slug, tablet);
      expect((await access.accessOverview(tournamentId, 2)).players[P.a1]).toMatchObject({ open: false, seen: "just now" });
      expect(await access.playerAccess(slug, tablet)).toMatchObject({ status: "signed_in", playerId: P.a1 });
      expect((await access.accessOverview(tournamentId, 2)).players[P.a1]).toMatchObject({ open: true });
    });

    it("signing out ends the session and its notifications", async () => {
      await push.savePushSubscription(slug, { playerId: P.a1, subscription: subscription("tablet") });
      await access.signOutPlayer(slug, tablet);
      expect(await access.playerAccess(slug, tablet)).toEqual({ status: "none" });
      expect(await subscriptionsOf(P.a1)).toHaveLength(0);
      expect((await access.accessOverview(tournamentId, 2)).players[P.a1]).toBeUndefined();
    });

    it("locks a player after 10 wrong tries, even against the right passcode", async () => {
      const { passcode } = await player(P.b1);
      for (let i = 0; i < 10; i++) {
        expect(await access.signInPlayer(slug, { playerId: P.b1, code: wrongCode(passcode) }, from(`guesser-${i}`))).toEqual({ status: "wrong" });
      }
      const locked = await access.signInPlayer(slug, { playerId: P.b1, code: passcode }, from("venue"));
      if (locked.status !== "throttled") throw new Error(`expected a lock, got ${locked.status}`);
      expect(locked.retryInSeconds).toBeGreaterThan(540);
      expect(locked.retryInSeconds).toBeLessThanOrEqual(600);
      // Other players are unaffected, and the QR code still works for the locked one.
      const other = await player(P.a1);
      expect(await access.signInPlayer(slug, { playerId: P.a1, code: other.passcode }, from("venue"))).toMatchObject({ status: "ok" });
      expect(await access.signInPlayer(slug, { token: (await player(P.b1)).signInToken }, from("venue"))).toMatchObject({ status: "ok", playerId: P.b1 });
    });

    it("a reset issues a new passcode and QR secret, signs the player out and lifts the lock", async () => {
      const before = await player(P.b1);
      expect(await access.resetPlayerAccess(stranger, tournamentId, P.b1)).toBe(false);
      expect(await access.resetPlayerAccess(organizerId, tournamentId, "999")).toBe(false);
      expect(await access.resetPlayerAccess(organizerId, tournamentId, P.b1)).toBe(true);

      const after = await player(P.b1);
      expect(after.signInToken).not.toBe(before.signInToken);
      expect(after.passcode).toMatch(/^\d{4}$/);
      expect((await access.accessOverview(tournamentId, 2)).players[P.b1]).toBeUndefined();
      expect(await access.signInPlayer(slug, { token: before.signInToken }, from("venue"))).toEqual({ status: "wrong" });
      expect(await access.signInPlayer(slug, { playerId: P.b1, code: after.passcode }, from("venue"))).toMatchObject({ status: "ok" });
    });

    it("slows down a network that keeps guessing, without locking out everyone else", async () => {
      for (let i = 0; i < 30; i++) {
        expect(await access.signInPlayer(slug, { playerId: "999", code: "0000" }, from("noisy"))).toEqual({ status: "wrong" });
      }
      const { passcode } = await player(P.a1);
      expect(await access.signInPlayer(slug, { playerId: P.a1, code: passcode }, from("noisy"))).toMatchObject({ status: "throttled" });
      expect(await access.signInPlayer(slug, { playerId: P.a1, code: passcode }, from("quiet"))).toMatchObject({ status: "ok" });
    });

    it("re-importing keeps every player's passcode", async () => {
      const before = await player(P.a1);
      await importTournament(organizerId, "18602864");
      expect(await player(P.a1)).toMatchObject({ passcode: before.passcode, signInToken: before.signInToken });
    });

    it("answers nothing useful for an unknown tournament", async () => {
      expect(await access.signInPlayer("0000000000000000", { playerId: P.a1, code: "0000" }, from("venue"))).toEqual({ status: "not_found" });
      expect(await signInInfo("0000000000000000")).toBeNull();
    });
  });
});
