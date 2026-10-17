// A Swiss against the real database: the first round by seed, each next round paired as soon as
// the last result of a round is in, byes, a player who drops out, and finishing after the last round.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bladers, createOrganizer, enabled, playMatch, playOut, removeOrganizer, seedTournament, type Seeded } from "./helpers";

describe.skipIf(!enabled)("a Swiss against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq, and, asc } = await import("drizzle-orm");
  const { applyBattleOps, activeBattles } = await import("@/lib/battles");
  const { finishTournament } = await import("@/lib/tournament/stages");
  const { boardSnapshot } = await import("@/lib/board");

  let organizerId: string;
  let t: Seeded;
  const roundOf = async (tournamentId: string, round: number) =>
    db
      .select()
      .from(schema.matches)
      .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.round, round)))
      .orderBy(asc(schema.matches.playOrder));
  const pairs = (rows: (typeof schema.matches.$inferSelect)[], seeded: Seeded) =>
    rows.map((m) => (m.bye ? `bye:${seeded.name(m.player1Id)}` : `${seeded.name(m.player1Id)} v ${seeded.name(m.player2Id)}`));

  beforeAll(async () => {
    organizerId = await createOrganizer();
    t = await seedTournament(organizerId, { format: "swiss", players: bladers(8) });
  });

  afterAll(async () => {
    await removeOrganizer(organizerId);
    await db.$client.end();
  });

  it("starts with the first round only, top half against bottom half, and the suggested number of rounds", async () => {
    const [tournament] = await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, t.tournamentId));
    expect(tournament.swissRounds).toBe(3);
    expect(pairs(await roundOf(t.tournamentId, 1), t)).toEqual(["Blader 01 v Blader 05", "Blader 02 v Blader 06", "Blader 03 v Blader 07", "Blader 04 v Blader 08"]);
    expect(await roundOf(t.tournamentId, 2)).toEqual([]);
  });

  it("pairs nothing in the middle of a round", async () => {
    expect(await playOut(organizerId, t, { limit: 3 })).toBe(3);
    expect(await roundOf(t.tournamentId, 2)).toEqual([]);
  });

  it("pairs the next round as soon as the last result of a round is in, by wins, with no rematch", async () => {
    await playOut(organizerId, t, { limit: 1 });
    expect(pairs(await roundOf(t.tournamentId, 2), t)).toEqual(["Blader 01 v Blader 03", "Blader 02 v Blader 04", "Blader 05 v Blader 07", "Blader 06 v Blader 08"]);
    expect((await roundOf(t.tournamentId, 2)).map((m) => m.number)).toEqual([5, 6, 7, 8]);
  });

  it("won't finish between rounds", async () => {
    await playOut(organizerId, t, { limit: 4 });
    // Round 3 is paired at once, so its matches are what is left.
    expect(await finishTournament(organizerId, t.tournamentId)).toEqual({ status: "blocked", error: "4 matches still to play." });
  });

  it("corrects a result of an earlier round without asking, and keeps the later pairings", async () => {
    const [first] = await roundOf(t.tournamentId, 1);
    const round3 = pairs(await roundOf(t.tournamentId, 3), t);
    await applyBattleOps(
      organizerId,
      first.id,
      (await activeBattles(first.id)).map((b) => ({ op: "void" as const, opId: randomUUID(), targetOpId: b.opId })),
    );
    expect(await playMatch(organizerId, first.id, 2)).toEqual({ status: "synced" });
    expect(pairs(await roundOf(t.tournamentId, 3), t)).toEqual(round3);
  });

  it("pairs nothing after the last round, and finishes by the standings", async () => {
    await playOut(organizerId, t);
    expect(await roundOf(t.tournamentId, 4)).toEqual([]);
    expect(await finishTournament(organizerId, t.tournamentId)).toEqual({ status: "finished", ranked: 8 });
    const { standings } = (await boardSnapshot(t.slug))!;
    expect(standings!.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("gives a bye with an odd number of players: a win, never queued, never twice", async () => {
    const odd = await seedTournament(organizerId, { format: "swiss", players: bladers(5) });
    const first = await roundOf(odd.tournamentId, 1);
    expect(pairs(first, odd)).toEqual(["Blader 01 v Blader 03", "Blader 02 v Blader 04", "bye:Blader 05"]);
    expect(first.at(-1)).toMatchObject({ state: "complete", winnerId: odd.id("Blader 05"), callStatus: "none" });
    await playOut(organizerId, odd);
    const byes = (await db.select().from(schema.matches).where(and(eq(schema.matches.tournamentId, odd.tournamentId), eq(schema.matches.bye, true)))).map((m) => m.player1Id);
    expect(new Set(byes).size).toBe(byes.length);
    expect(await finishTournament(organizerId, odd.tournamentId)).toEqual({ status: "finished", ranked: 5 });
  });

  it("leaves a player who dropped out out of the next round, their results still counting", async () => {
    const dropping = await seedTournament(organizerId, { format: "swiss", players: bladers(6) });
    await db.update(schema.participants).set({ active: false }).where(eq(schema.participants.id, dropping.id("Blader 06")));
    await playOut(organizerId, dropping, { limit: 3 });
    const second = pairs(await roundOf(dropping.tournamentId, 2), dropping);
    expect(second.join(" ")).not.toContain("Blader 06");
    expect(second.filter((p) => p.startsWith("bye:"))).toHaveLength(1);
  });
});
