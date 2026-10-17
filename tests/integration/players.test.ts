// Players against the real database: setting a tournament up before it starts, dropping a player
// once it has (their matches forfeited), a late player in a Swiss, and deleting a tournament.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bladers, createOrganizer, enabled, playOut, removeOrganizer, seedTournament } from "./helpers";

describe.skipIf(!enabled)("players against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq, and, asc } = await import("drizzle-orm");
  const players = await import("@/lib/tournament/players");
  const { createTournament, startTournament } = await import("@/lib/tournament/create");
  const { finishTournament } = await import("@/lib/tournament/stages");

  let organizerId: string;
  const list = async (tournamentId: string) =>
    (await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, tournamentId)).orderBy(asc(schema.participants.seed))).map(
      (p) => p.name,
    );
  const idOf = async (tournamentId: string, name: string) =>
    (await db.select().from(schema.participants).where(and(eq(schema.participants.tournamentId, tournamentId), eq(schema.participants.name, name))))[0].id;
  const matchesOf = (tournamentId: string) =>
    db.select().from(schema.matches).where(eq(schema.matches.tournamentId, tournamentId)).orderBy(asc(schema.matches.playOrder));

  beforeAll(async () => {
    organizerId = await createOrganizer();
  });

  afterAll(async () => {
    await removeOrganizer(organizerId);
    await db.$client.end();
  });

  describe("before the start", () => {
    let tournamentId: string;

    it("creates a tournament with no players yet, and refuses to start it", async () => {
      const created = await createTournament(organizerId, { name: "Spring Open", format: "single_elimination" });
      if ("error" in created) throw new Error(created.error);
      tournamentId = created.id;
      expect(await list(tournamentId)).toEqual([]);
      expect(await startTournament(organizerId, tournamentId)).toEqual({ error: "A tournament needs at least 2 players." });
    });

    it("refuses options that don't fit together when creating", async () => {
      expect(await createTournament(organizerId, { name: "X", format: "double_elimination", thirdPlace: true })).toEqual({
        error: "Only single elimination has a third-place match.",
      });
      expect(await createTournament(organizerId, { name: "X", format: "single_elimination", players: ["Alex", "alex"] })).toEqual({
        error: "alex is in the list twice.",
      });
    });

    it("adds players in seed order, one or many, and refuses a name already there", async () => {
      expect(await players.addPlayers(organizerId, tournamentId, ["Alex", "Sam", "Riley"])).toEqual({});
      expect(await players.addPlayers(organizerId, tournamentId, ["Jordan"])).toEqual({});
      expect(await players.addPlayers(organizerId, tournamentId, ["sam"])).toEqual({ error: "sam is in the list twice." });
      expect(await list(tournamentId)).toEqual(["Alex", "Sam", "Riley", "Jordan"]);
    });

    it("moves a player up or down a seed, and does nothing past the ends", async () => {
      expect(await players.moveSeed(organizerId, tournamentId, await idOf(tournamentId, "Jordan"), -1)).toEqual({});
      expect(await players.moveSeed(organizerId, tournamentId, await idOf(tournamentId, "Alex"), -1)).toEqual({});
      expect(await list(tournamentId)).toEqual(["Alex", "Sam", "Jordan", "Riley"]);
    });

    it("renames and removes a player, the seeds below moving up", async () => {
      expect(await players.renamePlayer(organizerId, tournamentId, await idOf(tournamentId, "Sam"), "  Samuel ")).toEqual({});
      expect(await players.renamePlayer(organizerId, tournamentId, await idOf(tournamentId, "Samuel"), "alex")).toEqual({ error: "alex is in the list twice." });
      expect(await players.removePlayer(organizerId, tournamentId, await idOf(tournamentId, "Alex"))).toEqual({});
      expect(await list(tournamentId)).toEqual(["Samuel", "Jordan", "Riley"]);
      const seeds = (await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, tournamentId))).map((p) => p.seed).sort();
      expect(seeds).toEqual([1, 2, 3]);
    });

    it("shuffles the seeds, keeping every player", async () => {
      await players.addPlayers(organizerId, tournamentId, bladers(13));
      const before = await list(tournamentId);
      expect(await players.shuffleSeeds(organizerId, tournamentId)).toEqual({});
      const after = await list(tournamentId);
      expect([...after].sort()).toEqual([...before].sort());
      expect(after).not.toEqual(before);
    });

    it("refuses another organizer, and fixes the players once started", async () => {
      expect(await players.addPlayers(randomUUID(), tournamentId, ["Zed"])).toEqual({ error: "Tournament not found." });
      expect(await startTournament(organizerId, tournamentId)).toEqual({});
      expect(await players.addPlayers(organizerId, tournamentId, ["Zed"])).toEqual({ error: "The tournament has started, so its players and seeds are fixed." });
      expect(await players.removePlayer(organizerId, tournamentId, await idOf(tournamentId, "Riley"))).toMatchObject({ error: expect.stringMatching(/fixed/) });
      // A name can still be fixed.
      expect(await players.renamePlayer(organizerId, tournamentId, await idOf(tournamentId, "Riley"), "Riley K.")).toEqual({});
    });
  });

  describe("dropping a player", () => {
    it("forfeits their open match in double elimination, then the losers-bracket match they reach", async () => {
      const t = await seedTournament(organizerId, { players: bladers(4) });
      // A: 01 v 04, B: 02 v 03. 04 drops: A goes to 01 by forfeit; 04 drops to the losers bracket.
      expect(await players.dropPlayer(organizerId, t.tournamentId, t.id("Blader 04"))).toEqual({});
      const [a] = await matchesOf(t.tournamentId);
      expect(a).toMatchObject({ state: "complete", winnerId: t.id("Blader 01"), forfeit: true, scores: null });
      // Once B is played, the losers-bracket match against 04 opens, and is forfeited too.
      await playOut(organizerId, t, { limit: 1 });
      const losers = (await matchesOf(t.tournamentId)).find((m) => m.section === "losers")!;
      expect(losers).toMatchObject({ state: "complete", forfeit: true, winnerId: t.id("Blader 03") });
      await playOut(organizerId, t);
      expect(await finishTournament(organizerId, t.tournamentId)).toMatchObject({ status: "finished" });
      const four = (await db.select().from(schema.participants).where(eq(schema.participants.id, t.id("Blader 04"))))[0];
      expect(four).toMatchObject({ active: false, finalRank: 4 });
    });

    it("refuses before the start, twice, and after the finish", async () => {
      const pending = await seedTournament(organizerId, { players: bladers(4) }, { start: false });
      expect(await players.dropPlayer(organizerId, pending.tournamentId, pending.id("Blader 01"))).toEqual({ error: "The tournament hasn't started: remove the player instead." });
      const t = await seedTournament(organizerId, { format: "round_robin", players: bladers(3) });
      expect(await players.dropPlayer(organizerId, t.tournamentId, t.id("Blader 03"))).toEqual({});
      expect(await players.dropPlayer(organizerId, t.tournamentId, t.id("Blader 03"))).toEqual({ error: "Blader 03 has already dropped out." });
      // In a round robin every match of theirs is open, so all of them are forfeited.
      const theirs = (await matchesOf(t.tournamentId)).filter((m) => [m.player1Id, m.player2Id].includes(t.id("Blader 03")));
      expect(theirs.every((m) => m.forfeit && m.state === "complete")).toBe(true);
      await playOut(organizerId, t);
      await finishTournament(organizerId, t.tournamentId);
      expect(await players.dropPlayer(organizerId, t.tournamentId, t.id("Blader 01"))).toEqual({ error: "The tournament is finished." });
    });

    it("in a Swiss, forfeits their match of the round and pairs them no more", async () => {
      const t = await seedTournament(organizerId, { format: "swiss", players: bladers(6) });
      await playOut(organizerId, t, { limit: 2 });
      // The last match of round 1 has Blader 03 in it; dropping them ends the round and pairs round 2.
      expect(await players.dropPlayer(organizerId, t.tournamentId, t.id("Blader 03"))).toEqual({});
      const round2 = (await matchesOf(t.tournamentId)).filter((m) => m.round === 2);
      expect(round2).toHaveLength(3);
      expect(round2.flatMap((m) => [m.player1Id, m.player2Id])).not.toContain(t.id("Blader 03"));
      expect(round2.filter((m) => m.bye)).toHaveLength(1);
    });
  });

  describe("a late player in a Swiss", () => {
    it("joins with no wins and is paired from the next round", async () => {
      const t = await seedTournament(organizerId, { format: "swiss", players: bladers(5) });
      expect(await players.addLatePlayer(organizerId, t.tournamentId, "Latecomer")).toEqual({});
      await playOut(organizerId, t, { limit: 2 });
      const round2 = (await matchesOf(t.tournamentId)).filter((m) => m.round === 2);
      const late = await idOf(t.tournamentId, "Latecomer");
      expect(round2.some((m) => !m.bye && [m.player1Id, m.player2Id].includes(late))).toBe(true);
      // Six players now: no bye.
      expect(round2.filter((m) => m.bye)).toHaveLength(0);
    });

    it("is refused outside a running Swiss, and once every round is paired", async () => {
      const bracket = await seedTournament(organizerId, { players: bladers(4) });
      expect(await players.addLatePlayer(organizerId, bracket.tournamentId, "Late")).toEqual({ error: "Players can join late only in a Swiss." });
      const t = await seedTournament(organizerId, { format: "swiss", players: bladers(4), swissRounds: 1 });
      expect(await players.addLatePlayer(organizerId, t.tournamentId, "Late")).toEqual({ error: "Every round is already paired, so there is none left to join." });
    });
  });

  describe("deleting a tournament", () => {
    it("needs the tournament's name, then removes everything in it", async () => {
      const t = await seedTournament(organizerId, { name: "Delete Me", players: bladers(4) });
      expect(await players.deleteTournament(organizerId, t.tournamentId, "delete me")).toEqual({ error: "Type the tournament's name exactly to delete it." });
      expect(await players.deleteTournament(randomUUID(), t.tournamentId, "Delete Me")).toEqual({ error: "Tournament not found." });
      expect(await players.deleteTournament(organizerId, t.tournamentId, " Delete Me ")).toEqual({});
      expect(await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, t.tournamentId))).toEqual([]);
      expect(await matchesOf(t.tournamentId)).toEqual([]);
    });
  });
});
