// A round robin against the real database: every match open from the start, results and
// corrections that change their own match only, standings, and finishing by the standings.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganizer, enabled, playMatch, playOut, removeOrganizer, seedTournament, type Seeded } from "./helpers";

describe.skipIf(!enabled)("a round robin against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq, and } = await import("drizzle-orm");
  const { activeBattles, applyBattleOps } = await import("@/lib/battles");
  const { addStadium } = await import("@/lib/venue");
  const { judgeMyself } = await import("@/lib/judges");
  const { finishTournament } = await import("@/lib/tournament/stages");
  const { boardSnapshot } = await import("@/lib/board");
  const { standingsTables } = await import("@/lib/standings");

  let organizerId: string;
  let t: Seeded;
  const players = ["Blader 01", "Blader 02", "Blader 03", "Blader 04"];
  const localMatches = () => db.select().from(schema.matches).where(eq(schema.matches.tournamentId, t.tournamentId));
  const localMatch = async (number: number) =>
    (await db.select().from(schema.matches).where(and(eq(schema.matches.tournamentId, t.tournamentId), eq(schema.matches.number, number))))[0];

  beforeAll(async () => {
    organizerId = await createOrganizer();
    t = await seedTournament(organizerId, { format: "round_robin", players });
  });

  afterAll(async () => {
    await removeOrganizer(organizerId);
    await db.$client.end();
  });

  it("starts with every match open, three rounds of two", async () => {
    const rows = await localMatches();
    expect(rows.map((m) => `${m.number}:r${m.round}:${m.state}`).sort()).toEqual(["1:r1:open", "2:r1:open", "3:r2:open", "4:r2:open", "5:r3:open", "6:r3:open"]);
    expect(rows.every((m) => !m.winnerTo && !m.loserTo)).toBe(true);
  });

  it("records a result and changes nothing else", async () => {
    const before = await localMatches();
    const a = await localMatch(1);
    expect(await playMatch(organizerId, a.id, 1)).toEqual({ status: "synced" });
    expect(await localMatch(1)).toMatchObject({ state: "complete", winnerId: a.player1Id, scores: "4-1" });
    const after = await localMatches();
    expect(after.filter((m) => m.number !== 1).map((m) => [m.number, m.state, m.player1Id, m.player2Id]).sort()).toEqual(
      before.filter((m) => m.number !== 1).map((m) => [m.number, m.state, m.player1Id, m.player2Id]).sort(),
    );
  });

  it("a result at a stadium frees it and calls the next match", async () => {
    await addStadium(organizerId, t.tournamentId);
    const [stadium] = await db.select().from(schema.stadiums).where(eq(schema.stadiums.tournamentId, t.tournamentId));
    await judgeMyself(organizerId, stadium.id);
    const b = await localMatch(2);
    expect(b.callStatus).toBe("called");
    expect(await playMatch(organizerId, b.id, 1)).toEqual({ status: "synced" });
    expect(await localMatch(3)).toMatchObject({ callStatus: "called", stadiumId: stadium.id });
  });

  it("a corrected winner needs no confirmation and changes that match only", async () => {
    const a = await localMatch(1);
    const voids = (await activeBattles(a.id)).map((battle) => ({ op: "void" as const, opId: randomUUID(), targetOpId: battle.opId }));
    await applyBattleOps(organizerId, a.id, voids);
    expect(await playMatch(organizerId, a.id, 2)).toEqual({ status: "synced" });
    expect(await localMatch(1)).toMatchObject({ winnerId: a.player2Id, scores: "1-4" });
  });

  it("shows running standings on the Desk and the board", async () => {
    const [tournament] = await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, t.tournamentId));
    const people = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, t.tournamentId));
    const [table] = standingsTables(tournament, await localMatches(), people);
    expect(table.rows.map((r) => r.record)).toEqual(["1-0", "1-0", "0-1", "0-1"]);
    expect((await boardSnapshot(t.slug))!.tables.map((x) => x.title)).toEqual(["Standings"]);
  });

  it("finishes after the last match with the standings as the places", async () => {
    expect(await finishTournament(organizerId, t.tournamentId)).toMatchObject({ status: "blocked" });
    await playOut(organizerId, t);
    expect(await finishTournament(organizerId, t.tournamentId)).toEqual({ status: "finished", ranked: 4 });
    const people = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, t.tournamentId));
    // 01 and 02 are 2-1 on the same Buchholz, and 01 beat 02; 03 and 04 are 1-2 on the same Buchholz, and 03 beat 04.
    expect(Object.fromEntries(people.map((p) => [p.name, p.finalRank]))).toEqual({ "Blader 01": 1, "Blader 02": 2, "Blader 03": 3, "Blader 04": 4 });
  });

  it("can schedule every pair twice, the second time with the sides swapped", async () => {
    const twice = await seedTournament(organizerId, { format: "round_robin", players: ["Blader 01", "Blader 02", "Blader 03"], roundRobinLegs: 2 });
    const rows = await db.select().from(schema.matches).where(eq(schema.matches.tournamentId, twice.tournamentId));
    expect(rows).toHaveLength(6);
    const pairs = rows.map((m) => `${twice.name(m.player1Id)} v ${twice.name(m.player2Id)}`);
    for (const pair of pairs) expect(pairs).toContain(pair.split(" v ").reverse().join(" v "));
  });
});
