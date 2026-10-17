// What the database tests share: an organizer, tournaments made and started through BXQ's own
// bracket engine, and a judge's taps that win a match.
import { randomUUID } from "node:crypto";
import type { TournamentInput } from "@/lib/tournament/create";

export const enabled = Boolean(process.env.DATABASE_URL);

/** "Blader 01" … for n players, in seed order. */
export const bladers = (n: number) => Array.from({ length: n }, (_, i) => `Blader ${String(i + 1).padStart(2, "0")}`);

export async function createOrganizer(): Promise<string> {
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const organizerId = randomUUID();
  await db.execute(sql`insert into auth.users (id, email, aud, role, instance_id)
    values (${organizerId}, ${`it-${organizerId}@example.test`}, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`);
  return organizerId;
}

/** Removes the organizer's tournaments (and with them everything else) and the organizer. */
export async function removeOrganizer(organizerId: string) {
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  await db.delete(schema.tournaments).where(eq(schema.tournaments.organizerId, organizerId));
  await db.execute(sql`delete from auth.users where id = ${organizerId}`);
}

export type Seeded = {
  tournamentId: string;
  slug: string;
  /** Player id by name. */
  id: (name: string) => string;
  /** Player name by id. */
  name: (id: string | null) => string | null;
};

/** Creates a tournament and starts it, unless `start` is false. Defaults: 16 players, double elimination. */
export async function seedTournament(
  organizerId: string,
  input: Partial<TournamentInput> = {},
  options: { start?: boolean } = {},
): Promise<Seeded> {
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const { createTournament, startTournament } = await import("@/lib/tournament/create");
  const created = await createTournament(organizerId, { name: "Autumn Clash", format: "double_elimination", players: bladers(16), ...input });
  if ("error" in created) throw new Error(created.error);
  if (options.start !== false) {
    const started = await startTournament(organizerId, created.id);
    if (started.error) throw new Error(started.error);
  }
  const [tournament] = await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, created.id));
  const people = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, created.id));
  return {
    tournamentId: created.id,
    slug: tournament.publicSlug,
    id: (name) => people.find((p) => p.name === name)!.id,
    name: (id) => people.find((p) => p.id === id)?.name ?? null,
  };
}

/** The battles that win a first-to-4 match for `side`, 4–1: Xtreme, a Spin back, then a Spin. */
export function winningBattles(side: 1 | 2) {
  const other: 1 | 2 = side === 1 ? 2 : 1;
  return [
    { op: "add" as const, opId: randomUUID(), kind: "xtreme" as const, side },
    { op: "add" as const, opId: randomUUID(), kind: "spin" as const, side: other },
    { op: "add" as const, opId: randomUUID(), kind: "spin" as const, side },
  ];
}

/** Starts the match if it was called, taps it to a win for `side`, and records the result. */
export async function playMatch(organizerId: string, matchId: string, side: 1 | 2, options: { confirmDestructive?: boolean } = {}) {
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const { applyBattleOps } = await import("@/lib/battles");
  const { submitResult } = await import("@/lib/tournament/results");
  const [match] = await db.select().from(schema.matches).where(eq(schema.matches.id, matchId));
  const start = match.callStatus === "called" ? [{ op: "start" as const, opId: randomUUID() }] : [];
  const applied = await applyBattleOps(organizerId, matchId, [...start, ...winningBattles(side)]);
  if (applied?.rejected.length) throw new Error(applied.rejected[0].reason);
  return submitResult(organizerId, matchId, options);
}

/**
 * Plays every open match of the tournament (or of one stage) until none is left, the better seed
 * winning: the lower number in "Blader 03". Returns how many were played.
 */
export async function playOut(organizerId: string, t: Seeded, options: { stage?: "group" | "final"; limit?: number } = {}) {
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { and, asc, eq } = await import("drizzle-orm");
  const seedOf = (id: string | null) => Number(t.name(id)?.slice(-2));
  let played = 0;
  for (;;) {
    const [next] = await db
      .select()
      .from(schema.matches)
      .where(and(eq(schema.matches.tournamentId, t.tournamentId), eq(schema.matches.state, "open"), ...(options.stage ? [eq(schema.matches.stage, options.stage)] : [])))
      .orderBy(asc(schema.matches.playOrder))
      .limit(1);
    if (!next || played === (options.limit ?? Infinity)) return played;
    const outcome = await playMatch(organizerId, next.id, seedOf(next.player1Id) < seedOf(next.player2Id) ? 1 : 2);
    if (outcome.status !== "synced") throw new Error(JSON.stringify(outcome));
    played++;
  }
}
