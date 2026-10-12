// Battle-by-battle scores of finished matches against the real database: what the organizer
// sees (including undone battles) and what a player is sent (their own matches, nothing undone).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeChallonge } from "./fake-challonge";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

describe.skipIf(!enabled)("battle sheets against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq, and } = await import("drizzle-orm");
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials } = await import("@/lib/challonge/connection");
  const { importTournament } = await import("@/lib/challonge/sync");
  const { applyBattleOps } = await import("@/lib/battles");
  const { submitResult } = await import("@/lib/challonge/report");
  const { playerSnapshot } = await import("@/lib/board");
  const { organizerSheet, playerSheets } = await import("@/lib/battle-sheet");

  const fake = createFakeChallonge();
  const organizerId = randomUUID();
  let tournamentId: string;
  let slug: string;

  // Match A = Blader 01 vs Blader 16; match B = Blader 08 vs Blader 09.
  const P = { a1: "306531079", a2: "306531094", b1: "306531086" };
  const local = async (identifier: string) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.identifier, identifier)))
    )[0];
  const add = (kind: "spin" | "xtreme" | "draw" | "launch_error", side: 1 | 2 | null, opId = randomUUID()) => ({ op: "add" as const, opId, kind, side });

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

    // Match A: an Xtreme, a Spin the judge undid, a draw, a launch error, then the winning Spin.
    const a = await local("A");
    const undone = randomUUID();
    await applyBattleOps(organizerId, a.id, [
      add("xtreme", 1),
      add("spin", 2, undone),
      { op: "void", opId: randomUUID(), targetOpId: undone },
      add("draw", null),
      add("launch_error", 2),
      add("spin", 1),
    ]);
    expect(await submitResult(organizerId, a.id)).toEqual({ status: "synced" });
  });

  afterAll(async () => {
    await db.execute(sql`delete from auth.users where id = ${organizerId}`);
    vi.unstubAllGlobals();
    await db.$client.end();
  });

  it("gives the organizer every battle in recorded order, with the running score", async () => {
    const sheet = (await organizerSheet(organizerId, (await local("A")).id))!;
    expect(sheet).toMatchObject({
      round: "Winners R1",
      identifier: "A",
      players: { 1: "Blader 01", 2: "Blader 16" },
      winner: 1,
      score: { 1: 4, 2: 0 },
      recorded: true,
    });
    expect(
      sheet.entries.map((e) => (e.type === "battle" ? `B${e.line.number} ${e.line.who ?? "-"} ${e.line.what} +${e.line.points} ${e.line.score}` : `undone: ${e.who} ${e.what} (${e.reason})`)),
    ).toEqual([
      "B1 Blader 01 Xtreme +3 3–0",
      "undone: Blader 16 Spin (Undone by the judge)",
      "B2 - Draw · replayed +0 3–0",
      "B3 Blader 16 Launch error +0 3–0",
      "B4 Blader 01 Spin +1 4–0",
    ]);
    const strike = sheet.entries.find((e) => e.type === "battle" && e.line.what === "Launch error");
    expect(strike).toMatchObject({ line: { note: "Strike 1 of 2" } });
  });

  it("sends a player their own finished match, from their side, without the undone battle", async () => {
    const [winner] = await playerSheets(slug, P.a1);
    expect(await playerSheets(slug, P.a1)).toHaveLength(1);
    expect(winner).toMatchObject({ identifier: "A", mine: 1, winner: 1, score: { 1: 4, 2: 0 } });
    expect(winner.entries).toHaveLength(4);
    expect(winner.entries.every((e) => e.type === "battle")).toBe(true);
    expect(JSON.stringify(winner)).not.toMatch(/Undone|voided/);

    const [loser] = await playerSheets(slug, P.a2);
    expect(loser).toMatchObject({ identifier: "A", mine: 2, winner: 1 });
  });

  it("sends nothing about matches the player wasn't in", async () => {
    expect(await playerSheets(slug, P.b1)).toEqual([]);
    expect(JSON.stringify(await playerSheets(slug, P.a1))).not.toContain("Blader 08");
  });

  it("shows nothing for a match that is still being played", async () => {
    const b = await local("B");
    await applyBattleOps(organizerId, b.id, [add("xtreme", 1)]);
    expect(await playerSheets(slug, P.b1)).toEqual([]);
  });

  it("tells the player's phone when one of their results changes, and only theirs", async () => {
    const before = (await playerSnapshot(slug, P.b1))!.results;
    expect(before).toBe("");
    expect((await playerSnapshot(slug, P.a1))!.results).toContain("A:4 - 0");

    const b = await local("B");
    await applyBattleOps(organizerId, b.id, [add("spin", 1)]);
    expect(await submitResult(organizerId, b.id)).toEqual({ status: "synced" });
    expect((await playerSnapshot(slug, P.b1))!.results).toContain("B:4 - 0");
    expect((await playerSnapshot(slug, P.a1))!.results).not.toContain("B:");
    expect(await playerSheets(slug, P.b1)).toHaveLength(1);
  });

  it("says so when a result was entered on Challonge and has no battles", async () => {
    const c = await local("C");
    await db
      .update(schema.matches)
      .set({ state: "complete", scores: "2 - 4", winnerChallongeId: c.player2ChallongeId })
      .where(eq(schema.matches.id, c.id));
    const sheet = (await organizerSheet(organizerId, c.id))!;
    expect(sheet).toMatchObject({ recorded: false, entries: [], winner: 2, score: { 1: 2, 2: 4 } });
    const [own] = await playerSheets(slug, c.player2ChallongeId!);
    expect(own).toMatchObject({ identifier: "C", mine: 2, recorded: false, entries: [] });
  });

  it("labels battles wiped by a cancel or a correction for the organizer", async () => {
    const a = await local("A");
    for (const reason of ["cancelled", "reset_by_correction"]) {
      await db.insert(schema.battles).values({ matchId: a.id, opId: randomUUID(), kind: "burst", side: 2, createdBy: organizerId, voidedAt: new Date(), voidReason: reason });
    }
    const reasons = (await organizerSheet(organizerId, a.id))!.entries.flatMap((e) => (e.type === "voided" ? [e.reason] : []));
    expect(reasons).toEqual(["Undone by the judge", "Match cancelled", "Reset by a correction"]);
    // Still none of them for the player.
    expect((await playerSheets(slug, P.a1))[0].entries).toHaveLength(4);
  });

  it("refuses another organizer and unknown tournaments", async () => {
    expect(await organizerSheet(randomUUID(), (await local("A")).id)).toBeNull();
    expect(await organizerSheet(organizerId, randomUUID())).toBeNull();
    expect(await playerSheets("0000000000000000", P.a1)).toEqual([]);
  });
});
