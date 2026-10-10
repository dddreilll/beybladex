// M4 against the real database: subscriptions and exactly-once call notifications (fake sender).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PushPayload } from "@/lib/push-endpoint";
import { createFakeChallonge } from "./fake-challonge";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

describe.skipIf(!enabled)("push notifications against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq, and } = await import("drizzle-orm");
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials } = await import("@/lib/challonge/connection");
  const { importTournament } = await import("@/lib/challonge/sync");
  const { applyBattleOps } = await import("@/lib/battles");
  const { submitResult } = await import("@/lib/challonge/report");
  const venue = await import("@/lib/venue");
  const push = await import("@/lib/push");

  const fake = createFakeChallonge();
  const organizerId = randomUUID();
  let tournamentId: string;
  let slug: string;

  // Match A = Blader 01 vs Blader 16; match B = Blader 08 vs Blader 09.
  const P = { a1: "306531079", a2: "306531094", b1: "306531086" };
  const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}-${organizerId}`;
  const subscription = (name: string) => ({ endpoint: endpoint(name), keys: { p256dh: "BObk_abc", auth: "q1w2e3" } });

  const sent: { to: string; payload: PushPayload; ttl: number }[] = [];
  let failWith: Record<string, number> = {};
  const sender = async (sub: { endpoint: string }, payload: PushPayload, ttl: number) => {
    const status = failWith[sub.endpoint] ?? 201;
    if (status < 300) sent.push({ to: sub.endpoint, payload, ttl });
    return status;
  };
  const dispatch = async () => {
    sent.length = 0;
    return push.dispatchNotifications(tournamentId, sender);
  };

  const local = async (identifier: string) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.identifier, identifier)))
    )[0];

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

  describe("subscriptions", () => {
    it("stores a subscription for a player of this tournament", async () => {
      expect(await push.savePushSubscription(slug, { playerId: P.a1, subscription: subscription("phone-a1") })).toBe("ok");
      expect(await push.savePushSubscription(slug, { playerId: P.a2, subscription: subscription("phone-a2") })).toBe("ok");
      expect(await push.savePushSubscription(slug, { playerId: P.b1, subscription: subscription("phone-b1") })).toBe("ok");
    });

    it("rejects unknown tournaments and players", async () => {
      expect(await push.savePushSubscription("0000000000000000", { playerId: P.a1, subscription: subscription("x") })).toBe("not_found");
      expect(await push.savePushSubscription(slug, { playerId: "999", subscription: subscription("x") })).toBe("not_found");
    });

    it("re-subscribing the same phone as another player moves it instead of duplicating", async () => {
      await push.savePushSubscription(slug, { playerId: P.a1, subscription: subscription("shared-phone") });
      await push.savePushSubscription(slug, { playerId: P.b1, subscription: subscription("shared-phone") });
      const rows = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint("shared-phone")));
      expect(rows).toHaveLength(1);
      expect(rows[0].participantChallongeId).toBe(P.b1);
      await push.removePushSubscription(slug, endpoint("shared-phone"));
      expect(await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint("shared-phone")))).toHaveLength(0);
    });
  });

  describe("call notifications", () => {
    it("notifies both called players and the on-deck players, each with their own opponent", async () => {
      await venue.addStadium(organizerId, tournamentId); // A called, B on deck
      const result = await dispatch();
      expect(result).toEqual({ sent: 3, removed: 0 });

      const byPhone = Object.fromEntries(sent.map((s) => [s.to, s]));
      expect(byPhone[endpoint("phone-a1")].payload).toMatchObject({ title: "You're up at Stadium 1", body: "vs Blader 16 · Winners R1 · A. Head there now.", url: `/t/${slug}` });
      expect(byPhone[endpoint("phone-a2")].payload.body).toContain("vs Blader 01");
      expect(byPhone[endpoint("phone-b1")].payload).toMatchObject({ title: "On deck at Stadium 1" });
      expect(byPhone[endpoint("phone-a1")].ttl).toBe(180);
      expect(byPhone[endpoint("phone-b1")].ttl).toBe(600);
    });

    it("never sends the same call twice", async () => {
      expect(await dispatch()).toEqual({ sent: 0, removed: 0 });
      const [first, second] = await Promise.all([push.dispatchNotifications(tournamentId, sender), push.dispatchNotifications(tournamentId, sender)]);
      expect(first.sent + second.sent).toBe(0);
    });

    it("doesn't notify when a called match starts playing", async () => {
      const a = await local("A");
      await applyBattleOps(organizerId, a.id, [{ op: "add", opId: randomUUID(), kind: "xtreme", side: 1 }]);
      expect((await local("A")).callStatus).toBe("playing");
      expect(await dispatch()).toEqual({ sent: 0, removed: 0 });
    });

    it("after a result, tells the on-deck players they're up", async () => {
      const a = await local("A");
      await applyBattleOps(organizerId, a.id, [{ op: "add", opId: randomUUID(), kind: "spin", side: 1 }]);
      expect(await submitResult(organizerId, a.id)).toEqual({ status: "synced" });
      await dispatch();
      const toB = sent.filter((s) => s.to === endpoint("phone-b1"));
      expect(toB).toHaveLength(1);
      expect(toB[0].payload).toMatchObject({ title: "You're up at Stadium 1", tag: `match-${(await local("B")).id}` });
      // A's players are done; nobody tells them anything.
      expect(sent.some((s) => s.to === endpoint("phone-a1"))).toBe(false);
    });

    it("notifies again when a held match is released and comes back on deck", async () => {
      // Stadium 1 is: B called, C on deck. B is a no-show.
      const b = await local("B");
      await venue.setHeld(organizerId, b.id, true); // C is called, D goes on deck
      await dispatch();
      expect(await local("B")).toMatchObject({ callStatus: "none", notifiedStatus: null });

      await venue.setHeld(organizerId, b.id, false); // back in the queue, first in play order
      await venue.setHeld(organizerId, (await local("C")).id, true); // D is called, B goes on deck
      await dispatch();
      expect(await local("B")).toMatchObject({ callStatus: "on_deck", notifiedStatus: "on_deck" });
      expect(sent.filter((x) => x.to === endpoint("phone-b1")).map((x) => x.payload.title)).toEqual(["On deck at Stadium 1"]);
    });

    it("removes subscriptions the push service says are gone and keeps the working ones", async () => {
      await push.savePushSubscription(slug, { playerId: P.b1, subscription: subscription("expired") });
      failWith = { [endpoint("expired")]: 410 };
      await db.update(schema.matches).set({ notifiedStatus: null }).where(eq(schema.matches.id, (await local("B")).id));
      const result = await dispatch();
      failWith = {};

      expect(result).toEqual({ sent: 1, removed: 1 });
      expect(await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint("expired")))).toHaveLength(0);
      const [kept] = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint("phone-b1")));
      expect(kept.lastSuccessAt).not.toBeNull();
    });
  });
});
