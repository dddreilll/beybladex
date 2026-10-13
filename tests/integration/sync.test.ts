// Runs against the local Supabase Postgres (DATABASE_URL in .env.local) with Challonge's HTTP API
// stubbed from recorded responses, so it exercises the real SQL without spending API budget.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import matchesFixture from "../fixtures/challonge/matches-started.json";
import participantsFixture from "../fixtures/challonge/participants.json";
import tournamentFixture from "../fixtures/challonge/tournament.json";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

type FakeState = {
  tournament: typeof tournamentFixture;
  matches: typeof matchesFixture;
  matchesEtag: string;
  tokenCalls: number;
  tokenResponse: () => Response;
  apiCalls: string[];
};

describe.skipIf(!enabled)("Challonge sync against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq } = await import("drizzle-orm");
  const { encryptSecret, decryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials, challongeClientFor, ReconnectRequiredError } = await import("@/lib/challonge/connection");
  const { importReviewed, importTournament, resyncTournament, reviewTournament } = await import("@/lib/challonge/sync");
  const { ReviewExpiredError } = await import("@/lib/challonge/import-review");
  const { UnsupportedFormatError } = await import("@/lib/challonge/support");
  const { monthlyUsage } = await import("@/lib/challonge/budget");

  const organizerId = randomUUID();
  let connectionId: string;
  const fake: FakeState = {
    tournament: structuredClone(tournamentFixture),
    matches: structuredClone(matchesFixture),
    matchesEtag: 'W/"m1"',
    tokenCalls: 0,
    tokenResponse: () => Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 604800, created_at: Math.floor(Date.now() / 1000) }),
    apiCalls: [],
  };

  const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/token") {
      fake.tokenCalls++;
      await new Promise((r) => setTimeout(r, 50)); // widen the race window for the lock test
      return fake.tokenResponse();
    }
    fake.apiCalls.push(url.pathname);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.pathname === "/v2.1/tournaments/xl4tobg6.json" || url.pathname === "/v2.1/tournaments/18602864.json") {
      return Response.json(fake.tournament);
    }
    if (url.pathname === "/v2.1/tournaments/18602864/participants.json") return Response.json(participantsFixture);
    if (url.pathname === "/v2.1/tournaments/18602864/matches.json") {
      if (headers["If-None-Match"] === fake.matchesEtag) return new Response(null, { status: 304, headers: { etag: fake.matchesEtag } });
      return Response.json(fake.matches, { headers: { etag: fake.matchesEtag } });
    }
    return Response.json({ errors: [{ detail: "not stubbed" }] }, { status: 404 });
  });

  const connection = async () =>
    (await db.select().from(schema.challongeConnections).where(eq(schema.challongeConnections.organizerId, organizerId)))[0];

  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeFetch);
    await db.execute(sql`insert into auth.users (id, email, aud, role, instance_id)
      values (${organizerId}, ${`it-${organizerId}@example.test`}, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`);
    await saveCredentials(organizerId, "test-client-id", "test-client-secret");
    connectionId = (await connection()).id;
  });

  beforeEach(async () => {
    // A connected organizer with a valid access token.
    await db
      .update(schema.challongeConnections)
      .set({
        accessTokenEnc: encryptSecret("access-1", `${organizerId}:access_token`),
        refreshTokenEnc: encryptSecret("refresh-1", `${organizerId}:refresh_token`),
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        status: "connected",
      })
      .where(eq(schema.challongeConnections.id, connectionId));
    fake.tokenCalls = 0;
    fake.apiCalls = [];
  });

  afterAll(async () => {
    if (organizerId) await db.execute(sql`delete from auth.users where id = ${organizerId}`);
    vi.unstubAllGlobals();
    await db.$client.end();
  });

  let tournamentId: string;

  it("imports a tournament with 3 requests and stores every participant and match", async () => {
    tournamentId = await importTournament(organizerId, "xl4tobg6");
    const [t] = await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, tournamentId));
    const participants = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, tournamentId));
    const matches = await db.select().from(schema.matches).where(eq(schema.matches.tournamentId, tournamentId));

    expect(t).toMatchObject({ organizerId, challongeId: "18602864", participantsCount: 16, matchesEtag: 'W/"m1"' });
    expect(participants).toHaveLength(16);
    expect(matches).toHaveLength(31);
    expect(matches.find((m) => m.identifier === "A")).toMatchObject({ player1ChallongeId: "306531079", state: "open" });
    expect(fake.apiCalls).toHaveLength(3);
    expect(await monthlyUsage(connectionId)).toBe(3);
  });

  it("re-importing the same tournament updates it instead of duplicating it", async () => {
    expect(await importTournament(organizerId, "18602864")).toBe(tournamentId);
    const rows = await db.select().from(schema.tournaments).where(eq(schema.tournaments.organizerId, organizerId));
    expect(rows).toHaveLength(1);
  });

  it("refuses a format the app can't run after 1 request, before anything is stored", async () => {
    const other = randomUUID();
    await db.execute(sql`insert into auth.users (id, email, aud, role, instance_id)
      values (${other}, ${`it-${other}@example.test`}, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`);
    await saveCredentials(other, "client-y", "secret-y");
    await db
      .update(schema.challongeConnections)
      .set({
        accessTokenEnc: encryptSecret("access-1", `${other}:access_token`),
        refreshTokenEnc: encryptSecret("refresh-1", `${other}:refresh_token`),
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        status: "connected",
      })
      .where(eq(schema.challongeConnections.organizerId, other));
    try {
      fake.tournament.data.attributes.tournament_type = "round robin";
      await expect(importTournament(other, "xl4tobg6")).rejects.toThrow("BXQ doesn't run round robin tournaments yet. It runs single and double elimination.");
      await expect(reviewTournament(other, "xl4tobg6")).rejects.toBeInstanceOf(UnsupportedFormatError);

      fake.tournament = structuredClone(tournamentFixture);
      fake.tournament.data.attributes.group_stage_enabled = true;
      await expect(importTournament(other, "xl4tobg6")).rejects.toThrow(/two-stage/);

      expect(fake.apiCalls).toEqual(Array(3).fill("/v2.1/tournaments/xl4tobg6.json"));
      expect(await db.select().from(schema.tournaments).where(eq(schema.tournaments.organizerId, other))).toHaveLength(0);
    } finally {
      fake.tournament = structuredClone(tournamentFixture);
      await db.execute(sql`delete from auth.users where id = ${other}`);
    }
  });

  it("a reviewed import costs 3 requests in all: 1 to review, 2 to confirm", async () => {
    const before = await monthlyUsage(connectionId);
    const { preview, token } = await reviewTournament(organizerId, "xl4tobg6");
    expect(preview).toMatchObject({ challongeId: "18602864", name: "[SPIKE]", tournamentType: "double elimination", participantsCount: 16, grandFinals: "reset" });
    expect(fake.apiCalls).toEqual(["/v2.1/tournaments/xl4tobg6.json"]);

    expect(await importReviewed(organizerId, token)).toBe(tournamentId);
    expect(fake.apiCalls.slice(1)).toEqual(["/v2.1/tournaments/18602864/participants.json", "/v2.1/tournaments/18602864/matches.json"]);
    expect(await monthlyUsage(connectionId)).toBe(before + 3);
    const matches = await db.select().from(schema.matches).where(eq(schema.matches.tournamentId, tournamentId));
    expect(matches).toHaveLength(31);
  });

  it("a review can only be confirmed by the organizer who made it, and asks Challonge nothing otherwise", async () => {
    const { token } = await reviewTournament(organizerId, "xl4tobg6");
    fake.apiCalls = [];
    await expect(importReviewed(randomUUID(), token)).rejects.toBeInstanceOf(ReviewExpiredError);
    await expect(importReviewed(organizerId, `${token}x`)).rejects.toBeInstanceOf(ReviewExpiredError);
    expect(fake.apiCalls).toHaveLength(0);
  });

  it("resync costs 2 requests when nothing changed (304)", async () => {
    const before = await monthlyUsage(connectionId);
    const result = await resyncTournament(organizerId, tournamentId);
    expect(result).toEqual({ matchesChanged: false, participantsRefetched: false });
    expect(await monthlyUsage(connectionId)).toBe(before + 2);
  });

  it("resync applies changed matches and removes ones Challonge no longer has", async () => {
    const changed = structuredClone(matchesFixture);
    const a = changed.data.find((m) => m.attributes.identifier === "A")!;
    a.attributes.state = "complete";
    (a.attributes as { winner_id: number | null }).winner_id = 306531079;
    a.attributes.scores = "4 - 1";
    changed.data = changed.data.filter((m) => m.attributes.identifier !== "Q");
    fake.matches = changed;
    fake.matchesEtag = 'W/"m2"';

    expect(await resyncTournament(organizerId, tournamentId)).toMatchObject({ matchesChanged: true });
    const matches = await db.select().from(schema.matches).where(eq(schema.matches.tournamentId, tournamentId));
    expect(matches).toHaveLength(30);
    expect(matches.find((m) => m.identifier === "A")).toMatchObject({ state: "complete", winnerChallongeId: "306531079", scores: "4 - 1" });
    const [t] = await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, tournamentId));
    expect(t.matchesEtag).toBe('W/"m2"');
  });

  it("another organizer cannot resync this tournament", async () => {
    await expect(resyncTournament(randomUUID(), tournamentId)).rejects.toThrow("Tournament not found.");
  });

  it("resync refuses a format the app can't run: 1 request, the bracket untouched, the format recorded", async () => {
    const before = await monthlyUsage(connectionId);
    const tournament = async () => (await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, tournamentId)))[0];
    const synced = (await tournament()).lastSyncedAt;

    // On challonge.com the tournament was reset and turned into Swiss, with a new set of matches.
    fake.tournament.data.attributes.tournament_type = "swiss";
    fake.matchesEtag = 'W/"m3"';
    await expect(resyncTournament(organizerId, tournamentId)).rejects.toThrow("BXQ doesn't run Swiss tournaments yet. It runs single and double elimination.");

    expect(fake.apiCalls).toEqual(["/v2.1/tournaments/18602864.json"]);
    expect(await monthlyUsage(connectionId)).toBe(before + 1);
    expect(await tournament()).toMatchObject({ tournamentType: "swiss", groupStage: false, matchesEtag: 'W/"m2"', lastSyncedAt: synced });
    expect(await db.select().from(schema.matches).where(eq(schema.matches.tournamentId, tournamentId))).toHaveLength(30);

    // Changed back on challonge.com, it syncs again.
    fake.tournament = structuredClone(tournamentFixture);
    expect(await resyncTournament(organizerId, tournamentId)).toMatchObject({ matchesChanged: true });
    expect((await tournament()).tournamentType).toBe("double elimination");
  });

  it("refreshes an expiring token once under concurrency and stores the rotated refresh token", async () => {
    await db
      .update(schema.challongeConnections)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.challongeConnections.id, connectionId));

    // More callers than the pool has connections (5), so a lock-holder needing a second connection would deadlock.
    const before = await monthlyUsage(connectionId);
    const clients = await Promise.all(Array.from({ length: 6 }, () => challongeClientFor(organizerId)));
    expect(fake.tokenCalls).toBe(1);
    expect(clients.every((x) => x.connection.tokenExpiresAt!.getTime() > Date.now())).toBe(true);
    expect(await monthlyUsage(connectionId)).toBe(before + 1);

    const row = await connection();
    expect(decryptSecret(row.accessTokenEnc!, `${organizerId}:access_token`)).toBe("access-2");
    expect(decryptSecret(row.refreshTokenEnc!, `${organizerId}:refresh_token`)).toBe("refresh-2");
  });

  it("marks the connection for reconnection when the refresh token is rejected", async () => {
    await db
      .update(schema.challongeConnections)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.challongeConnections.id, connectionId));
    const original = fake.tokenResponse;
    fake.tokenResponse = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    try {
      await expect(challongeClientFor(organizerId)).rejects.toBeInstanceOf(ReconnectRequiredError);
      expect((await connection()).status).toBe("reconnect_required");
      await expect(challongeClientFor(organizerId)).rejects.toBeInstanceOf(ReconnectRequiredError);
    } finally {
      fake.tokenResponse = original;
    }
  });

  it("deleting the organizer's account removes their connection and tournaments", async () => {
    const other = randomUUID();
    await db.execute(sql`insert into auth.users (id, email, aud, role, instance_id)
      values (${other}, ${`it-${other}@example.test`}, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`);
    await saveCredentials(other, "client-x", "secret-x");
    await db.execute(sql`delete from auth.users where id = ${other}`);
    const rows = await db.select().from(schema.challongeConnections).where(eq(schema.challongeConnections.organizerId, other));
    expect(rows).toHaveLength(0);
  });
});
