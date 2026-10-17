// Finishing a tournament against the real database: when it is allowed, the places it gives, and
// that results can't change afterwards.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganizer, enabled, playMatch, playOut, removeOrganizer, seedTournament, type Seeded } from "./helpers";

describe.skipIf(!enabled)("finishing a tournament against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq, and } = await import("drizzle-orm");
  const { finishTournament } = await import("@/lib/tournament/stages");
  const { submitResult } = await import("@/lib/tournament/results");
  const { boardSnapshot, playerSnapshot } = await import("@/lib/board");

  let organizerId: string;
  let t: Seeded;
  const localMatch = async (identifier: string) =>
    (await db.select().from(schema.matches).where(and(eq(schema.matches.tournamentId, t.tournamentId), eq(schema.matches.identifier, identifier))))[0];
  const tournament = async () => (await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, t.tournamentId)))[0];

  beforeAll(async () => {
    organizerId = await createOrganizer();
    // 8 players, single elimination with a third-place match: A to D, E and F, 3P, then the final G.
    t = await seedTournament(organizerId, { format: "single_elimination", players: Array.from({ length: 8 }, (_, i) => `Blader 0${i + 1}`), thirdPlace: true });
  });

  afterAll(async () => {
    await removeOrganizer(organizerId);
    await db.$client.end();
  });

  it("shows no standings while the tournament is running", async () => {
    expect((await boardSnapshot(t.slug))!.standings).toBeNull();
  });

  it("refuses while matches are still to play", async () => {
    await playOut(organizerId, t, { limit: 4 });
    expect(await finishTournament(organizerId, t.tournamentId)).toEqual({ status: "blocked", error: "2 matches still to play." });
    expect((await tournament()).state).toBe("underway");
  });

  it("refuses another organizer", async () => {
    expect(await finishTournament(randomUUID(), t.tournamentId)).toEqual({ status: "failed", error: "Tournament not found." });
  });

  it("finishes once everything is played, and places everyone: 3rd and 4th by the third-place match, then shared places", async () => {
    await playOut(organizerId, t);
    expect(await finishTournament(organizerId, t.tournamentId)).toEqual({ status: "finished", ranked: 8 });
    expect((await tournament()).state).toBe("complete");
    const places = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, t.tournamentId));
    expect(places.sort((a, b) => a.seed! - b.seed!).map((p) => p.finalRank)).toEqual([1, 2, 3, 4, 5, 5, 5, 5]);
  });

  it("puts the standings on the board, best first, with shared places", async () => {
    const { standings } = (await boardSnapshot(t.slug))!;
    expect(standings!.map((s) => `${s.rank} ${s.name}`)).toEqual([
      "1 Blader 01",
      "2 Blader 02",
      "3 Blader 03",
      "4 Blader 04",
      "5 Blader 05",
      "5 Blader 06",
      "5 Blader 07",
      "5 Blader 08",
    ]);
  });

  it("tells each player their own place", async () => {
    expect((await playerSnapshot(t.slug, t.id("Blader 01")))!.status).toEqual({ kind: "finished", rank: 1, of: 8 });
    expect((await playerSnapshot(t.slug, t.id("Blader 07")))!.status).toEqual({ kind: "finished", rank: 5, of: 8 });
  });

  it("won't finish twice, and won't change a result once finished", async () => {
    expect(await finishTournament(organizerId, t.tournamentId)).toEqual({ status: "blocked", error: "This tournament is already finished." });
    const final = await localMatch("G");
    expect(await submitResult(organizerId, final.id)).toEqual({ status: "invalid", error: "This tournament is finished, so its results can't be changed." });
    await expect(playMatch(organizerId, final.id, 2)).rejects.toThrow(/already decided/);
  });
});
