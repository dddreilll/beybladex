// Two-stage tournaments against the real database and a fake Challonge built from spike S17: a
// group stage of round robin or Swiss groups, the two steps to the final stage, and a finalize.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeTwoStage } from "./fake-two-stage";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

describe.skipIf(!enabled)("a two-stage tournament against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq } = await import("drizzle-orm");
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials } = await import("@/lib/challonge/connection");
  const { importTournament, resyncTournament } = await import("@/lib/challonge/sync");
  const { finalizeTournament } = await import("@/lib/challonge/finalize");
  const { endGroupStage, startFinalStage } = await import("@/lib/challonge/stage-change");
  const { monthlyUsage } = await import("@/lib/challonge/budget");
  const { applyBattleOps, activeBattles } = await import("@/lib/battles");
  const { submitResult, pairingWait } = await import("@/lib/challonge/report");
  const { isFinalsMatch } = await import("@/lib/rules");
  const { buildControlRoom } = await import("@/lib/control-room");
  const { playerSnapshot, signInInfo } = await import("@/lib/board");
  const waits = { ...pairingWait };

  /**
   * One organizer with a connected Challonge, and the helpers the tests of one fake share.
   * `unverifiedFinalStage` sets the switch that accepts a round robin or Swiss final stage.
   */
  function setup(fake: ReturnType<typeof createFakeTwoStage>, options: { unverifiedFinalStage?: boolean } = {}) {
    const organizerId = randomUUID();
    const world = { tournamentId: "", connectionId: "" };
    const tournament = async () => (await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, world.tournamentId)))[0];
    const localMatches = () => db.select().from(schema.matches).where(eq(schema.matches.tournamentId, world.tournamentId));
    const people = () => db.select().from(schema.participants).where(eq(schema.participants.tournamentId, world.tournamentId));
    /** Matches as "group/identifier", "final/identifier" in the final stage. */
    const key = (m: { stage: string; groupNumber: number | null; identifier: string }) => `${m.stage === "group" ? (m.groupNumber ?? "?") : "final"}/${m.identifier}`;
    const localMatch = async (which: string) => (await localMatches()).find((m) => key(m) === which)!;
    const add = (kind: string, side: 1 | 2) => ({ op: "add" as const, opId: randomUUID(), kind: kind as "spin", side });

    /** Scores a match to `winnerSide`, 4–1, via judge-pad ops, sends it, and says what that asked Challonge for. */
    async function play(which: string, winnerSide: 1 | 2 = 1, options: { confirmDestructive?: boolean } = {}) {
      const match = await localMatch(which);
      const loser = winnerSide === 1 ? 2 : 1;
      const applied = await applyBattleOps(organizerId, match.id, [add("xtreme", winnerSide), add("spin", loser), add("spin", winnerSide)]);
      expect(applied!.rejected).toEqual([]);
      const from = fake.state.requests.length;
      const result = await submitResult(organizerId, match.id, options);
      return { match, result, requests: fake.state.requests.slice(from) };
    }
    /** Undoes every battle of a match, as a judge does before entering a result again. */
    async function clearBattles(which: string) {
      const match = await localMatch(which);
      const battles = await activeBattles(match.id);
      await applyBattleOps(organizerId, match.id, battles.map((b) => ({ op: "void" as const, opId: randomUUID(), targetOpId: b.opId })));
    }
    /** Runs something and says what it asked Challonge for. */
    async function asked<T>(run: () => Promise<T>) {
      const from = fake.state.requests.length;
      const result = await run();
      return { result, requests: fake.state.requests.slice(from) };
    }

    beforeAll(async () => {
      vi.stubGlobal("fetch", fake.fetch);
      if (options.unverifiedFinalStage) vi.stubEnv("BXQ_UNVERIFIED_FINAL_STAGES", "1");
      // The waits before reading the next round are for the real Challonge.
      Object.assign(pairingWait, { firstMs: 0, secondMs: 0 });
      await db.execute(sql`insert into auth.users (id, email, aud, role, instance_id)
        values (${organizerId}, ${`it-${organizerId}@example.test`}, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`);
      await saveCredentials(organizerId, "client", "secret");
      const [conn] = await db.select().from(schema.challongeConnections).where(eq(schema.challongeConnections.organizerId, organizerId));
      world.connectionId = conn.id;
      await db
        .update(schema.challongeConnections)
        .set({
          accessTokenEnc: encryptSecret("access-1", `${organizerId}:access_token`),
          refreshTokenEnc: encryptSecret("refresh-1", `${organizerId}:refresh_token`),
          tokenExpiresAt: new Date(Date.now() + 86_400_000),
          status: "connected",
        })
        .where(eq(schema.challongeConnections.id, conn.id));
      world.tournamentId = await importTournament(organizerId, fake.slug);
    });

    afterAll(async () => {
      Object.assign(pairingWait, waits);
      await db.execute(sql`delete from auth.users where id = ${organizerId}`);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    const paths = {
      tournament: `GET /tournaments/${fake.id}.json`,
      matches: `GET /tournaments/${fake.id}/matches.json`,
      participants: `GET /tournaments/${fake.id}/participants.json`,
      state: `PUT /tournaments/${fake.id}/change_state.json`,
      result: (challongeId: string) => `PUT /tournaments/${fake.id}/matches/${challongeId}.json`,
    };
    return { organizerId, world, tournament, localMatches, localMatch, people, key, play, clearBattles, asked, paths };
  }

  afterAll(async () => {
    await db.$client.end();
  });

  describe("with round robin groups", () => {
    const fake = createFakeTwoStage("round robin");
    const { organizerId, world, tournament, localMatches, localMatch, people, key, play, asked, paths } = setup(fake);

    it("imports in 3 requests, with every match in its group", async () => {
      expect(fake.state.requests).toEqual([`GET /tournaments/${fake.slug}.json`, paths.participants, paths.matches]);
      expect(await tournament()).toMatchObject({
        tournamentType: "single elimination",
        groupStage: true,
        groupStageType: "round robin",
        groupSize: 3,
        state: "group_stages_underway",
        startedAt: null,
      });
      // Challonge names the matches A, B and C in each of the two groups.
      expect((await localMatches()).map(key).sort()).toEqual(["1/A", "1/B", "1/C", "2/A", "2/B", "2/C"]);
    });

    it("names the group in the queue, and lets the groups take turns", async () => {
      const room = buildControlRoom(await tournament(), await people(), await localMatches());
      expect(room.ready.map((m) => `${m.roundLabel} · ${m.identifier}`)).toEqual([
        "Group A · Round 1 · A",
        "Group B · Round 1 · A",
        "Group A · Round 2 · B",
        "Group B · Round 2 · B",
        "Group A · Round 3 · C",
        "Group B · Round 3 · C",
      ]);
    });

    it("sends a group result in 1 request", async () => {
      const a = await play("1/A");
      expect(a.result).toEqual({ status: "synced" });
      expect(a.requests).toEqual([paths.result(a.match.challongeId)]);
      expect(await localMatch("1/A")).toMatchObject({ state: "complete", winnerChallongeId: a.match.player1ChallongeId, scores: "4 - 1" });
    });

    it("won't finalize or end the group stage while group matches are open, without a request", async () => {
      const finalized = await asked(() => finalizeTournament(organizerId, world.tournamentId));
      expect(finalized).toEqual({ result: { status: "blocked", error: "The group stage is still being played." }, requests: [] });
      const ended = await asked(() => endGroupStage(organizerId, world.tournamentId));
      expect(ended).toEqual({ result: { status: "blocked", error: "5 matches still to play." }, requests: [] });
      const started = await asked(() => startFinalStage(organizerId, world.tournamentId));
      expect(started).toEqual({ result: { status: "blocked", error: "End the group stage first." }, requests: [] });
    });

    it("doesn't believe a 200 that changed nothing", async () => {
      for (const which of ["1/B", "1/C", "2/A", "2/B", "2/C"]) expect((await play(which)).result).toEqual({ status: "synced" });
      fake.state.ignoreStateChanges = true;
      const ended = await endGroupStage(organizerId, world.tournamentId);
      fake.state.ignoreStateChanges = false;
      expect(ended).toEqual({ status: "failed", error: 'Challonge answered, but the tournament is still "group_stages_underway" there. Check it on challonge.com.' });
      expect((await tournament()).state).toBe("group_stages_underway");
    });

    it("ends the group stage in 2 requests and learns who advances", async () => {
      const ended = await asked(() => endGroupStage(organizerId, world.tournamentId));
      expect(ended).toEqual({ result: { status: "done" }, requests: [paths.state, paths.participants] });
      expect((await tournament()).state).toBe("group_stages_finalized");

      const players = (await people()).sort((a, b) => a.seed! - b.seed!);
      // Seeds are now the order of advancing: the two group winners, then the two runners-up.
      expect(players.map((p) => `${p.name}:${p.advanced}`)).toEqual([
        "Blader 01:true",
        "Blader 04:true",
        "Blader 02:true",
        "Blader 05:true",
        "Blader 03:false",
        "Blader 06:false",
      ]);
      // Challonge deactivates whoever didn't advance; here they stay, so their Pass still opens.
      expect(players.every((p) => p.active)).toBe(true);
    });

    it("tells each player on their Pass whether they advanced", async () => {
      const { publicSlug } = await tournament();
      const byName = new Map((await people()).map((p) => [p.name, p.challongeId]));
      expect((await signInInfo(publicSlug))!.players).toHaveLength(6);
      expect((await playerSnapshot(publicSlug, byName.get("Blader 02")!))!.status).toEqual({ kind: "advanced" });
      expect((await playerSnapshot(publicSlug, byName.get("Blader 03")!))!.status).toEqual({ kind: "out" });
    });

    it("refuses to change a group result once the group stage has ended, without a request", async () => {
      const a = await localMatch("1/A");
      const corrected = await asked(() => submitResult(organizerId, a.id));
      expect(corrected).toEqual({
        result: { status: "invalid", error: "The group stage has ended on Challonge, so its results can't be changed." },
        requests: [],
      });
    });

    it("starts the final stage in 2 requests and tells its matches from the groups'", async () => {
      const started = await asked(() => startFinalStage(organizerId, world.tournamentId));
      expect(started).toEqual({ result: { status: "done" }, requests: [paths.state, paths.matches] });
      const now = await tournament();
      expect(now.state).toBe("underway");
      expect(now.startedAt).toBeInstanceOf(Date);
      expect((await localMatches()).map(key).sort()).toEqual(["1/A", "1/B", "1/C", "2/A", "2/B", "2/C", "final/A", "final/B", "final/C"]);

      const room = buildControlRoom(now, await people(), await localMatches());
      expect(room.ready.map((m) => `${m.roundLabel} · ${m.player1} vs ${m.player2}`)).toEqual([
        "Round 1 · Blader 01 vs Blader 05",
        "Round 1 · Blader 04 vs Blader 02",
      ]);
      expect(room.completed.every((m) => m.roundLabel.startsWith("Group "))).toBe(true);
    });

    it("sends a final-stage result in 2 requests, since it is a bracket", async () => {
      const a = await play("final/A");
      expect(a.result).toEqual({ status: "synced" });
      expect(a.requests).toEqual([paths.result(a.match.challongeId), paths.matches]);
      expect(await localMatch("final/C")).toMatchObject({ state: "pending", player1ChallongeId: a.match.player1ChallongeId });
    });

    it("gives the finals rules to the last match of the final stage only", async () => {
      const now = await tournament();
      expect(await isFinalsMatch(now, await localMatch("final/C"))).toBe(true);
      expect(await isFinalsMatch(now, await localMatch("final/A"))).toBe(false);
      // Round 3 is the last round of the groups, and a round like the others.
      expect(await isFinalsMatch(now, await localMatch("1/C"))).toBe(false);
    });

    it("always reads the participants in a resync: 3 requests", async () => {
      const resynced = await asked(() => resyncTournament(organizerId, world.tournamentId));
      expect(resynced.requests).toEqual([paths.tournament, paths.matches, paths.participants]);
      // The matches came back unchanged, and who advanced is as it was.
      expect(resynced.result).toEqual({ matchesChanged: false, participantsRefetched: true });
      expect((await people()).filter((p) => p.advanced).length).toBe(4);
      expect((await localMatches()).filter((m) => m.stage === "final")).toHaveLength(3);
    });

    it("finalizes in 5 requests and places everyone, whether they advanced or not", async () => {
      await play("final/B");
      expect((await play("final/C")).result).toEqual({ status: "synced" });

      const usage = await monthlyUsage(world.connectionId);
      expect(await finalizeTournament(organizerId, world.tournamentId)).toEqual({ status: "finalized", ranked: 6 });
      // A resync (the tournament, the matches, the participants), the finalize, and the placements.
      expect(await monthlyUsage(world.connectionId)).toBe(usage + 5);
      const ranks = (await people()).map((p) => `${p.name}:${p.finalRank}`).sort();
      expect(ranks).toEqual(["Blader 01:1", "Blader 02:3", "Blader 03:5", "Blader 04:2", "Blader 05:3", "Blader 06:5"]);

      const { publicSlug } = await tournament();
      const out = (await people()).find((p) => p.name === "Blader 03")!;
      expect((await playerSnapshot(publicSlug, out.challongeId))!.status).toEqual({ kind: "finished", rank: 5, of: 6 });
    });
  });

  describe("with Swiss groups", () => {
    const fake = createFakeTwoStage("swiss");
    const { organizerId, world, tournament, localMatches, localMatch, key, play, asked, paths } = setup(fake);
    const rounds = async () => (await localMatches()).map((m) => `${key(m)}:r${m.round}:${m.state}`).sort();

    it("imports only the first round of each group", async () => {
      expect(await tournament()).toMatchObject({ groupStageType: "swiss", groupSize: 4, swissRounds: null, state: "group_stages_underway" });
      expect(await rounds()).toEqual(["1/A:r1:open", "1/B:r1:open", "2/A:r1:open", "2/B:r1:open"]);
    });

    it("reads a group's next round after the last result of its round, whatever the other group is doing", async () => {
      const a = await play("1/A");
      expect(a.requests).toEqual([paths.result(a.match.challongeId)]);
      const b = await play("1/B");
      expect(b.result).toEqual({ status: "synced" });
      expect(b.requests).toEqual([paths.result(b.match.challongeId), paths.matches]);
      expect(await rounds()).toEqual(["1/A:r1:complete", "1/B:r1:complete", "1/C:r2:open", "1/D:r2:open", "2/A:r1:open", "2/B:r1:open"]);
    });

    it("reads twice after a group's last round and says nothing: Challonge doesn't tell how many rounds there are", async () => {
      await play("1/C");
      const d = await play("1/D");
      expect(d.result).toEqual({ status: "synced" });
      expect(d.requests).toEqual([paths.result(d.match.challongeId), paths.matches, paths.matches]);
      expect((await localMatches()).filter((m) => m.groupNumber === 1)).toHaveLength(4);
    });

    it("still reads the next round of a group that is a round behind the other", async () => {
      await play("2/A");
      const b = await play("2/B");
      // The tournament's last round is the first group's second; this group's own last round is its first.
      expect(b.requests).toEqual([paths.result(b.match.challongeId), paths.matches]);
      expect((await rounds()).filter((r) => r.startsWith("2/"))).toEqual(["2/A:r1:complete", "2/B:r1:complete", "2/C:r2:open", "2/D:r2:open"]);
    });

    it("passes on what Challonge says when the group stage can't end yet", async () => {
      expect(await endGroupStage(organizerId, world.tournamentId)).toEqual({ status: "blocked", error: "2 matches still to play." });
      await play("2/C");
      // The last result hasn't been sent from here; on Challonge the match is still open.
      const d = await localMatch("2/D");
      await db.update(schema.matches).set({ state: "complete" }).where(eq(schema.matches.id, d.id));
      const ended = await asked(() => endGroupStage(organizerId, world.tournamentId));
      expect(ended.requests).toEqual([paths.state]);
      expect(ended.result).toEqual({
        status: "failed",
        error: "Challonge refused to end the group stage: You must complete all group stage matches before finalizing the group stage. Resync to see where it stands.",
      });
      await db.update(schema.matches).set({ state: "open" }).where(eq(schema.matches.id, d.id));
    });

    it("keeps the later rounds in the group stage once the final stage has started", async () => {
      await play("2/D");
      expect(await endGroupStage(organizerId, world.tournamentId)).toEqual({ status: "done" });
      expect(await startFinalStage(organizerId, world.tournamentId)).toEqual({ status: "done" });
      const byStage = (await localMatches()).map(key).sort();
      expect(byStage).toEqual(["1/A", "1/B", "1/C", "1/D", "2/A", "2/B", "2/C", "2/D", "final/A", "final/B", "final/C"]);
      // The final stage is a bracket, so a result there is read back.
      const a = await play("final/A");
      expect(a.requests).toEqual([paths.result(a.match.challongeId), paths.matches]);
    });
  });

  describe("with single elimination groups", () => {
    const fake = createFakeTwoStage("single elimination");
    const { organizerId, world, tournament, localMatches, localMatch, people, key, play, asked, paths } = setup(fake);
    const room = async () => buildControlRoom(await tournament(), await people(), await localMatches());

    it("imports every group's bracket, the matches without players too", async () => {
      expect(await tournament()).toMatchObject({ tournamentType: "single elimination", groupStageType: "single elimination", groupSize: 4 });
      expect((await localMatches()).map((m) => `${key(m)}:${m.state}`).sort()).toEqual(["1/A:open", "1/B:open", "1/C:pending", "2/A:open", "2/B:open", "2/C:pending"]);
      expect((await room()).ready.map((m) => `${m.roundLabel} · ${m.identifier}`)).toEqual([
        "Group A · Round 1 · A",
        "Group B · Round 1 · A",
        "Group A · Round 1 · B",
        "Group B · Round 1 · B",
      ]);
    });

    it("sends a group result in 2 requests, since the group is a bracket, and sees the winner move on", async () => {
      const a = await play("1/A");
      expect(a.result).toEqual({ status: "synced" });
      expect(a.requests).toEqual([paths.result(a.match.challongeId), paths.matches]);
      expect(await localMatch("1/C")).toMatchObject({ state: "pending", player1ChallongeId: a.match.player1ChallongeId, player2ChallongeId: null });
      expect((await room()).waiting.map((m) => `${m.roundLabel} · ${m.player1} vs ${m.player2}`)).toEqual(["Group A · Final · Blader 01 vs TBD"]);
    });

    it("leaves the match between a group's last two players closed: it is never queued", async () => {
      await play("1/B");
      expect(await localMatch("1/C")).toMatchObject({ state: "pending", stage: "group", groupNumber: 1 });
      expect((await localMatch("1/C")).player2ChallongeId).not.toBeNull();
      const now = await room();
      expect(now.ready.map((m) => `${m.roundLabel} · ${m.identifier}`)).toEqual(["Group B · Round 1 · A", "Group B · Round 1 · B"]);
      expect(now.waiting).toEqual([]);
    });

    it("ends the group stage with those matches unplayed, once nothing is open", async () => {
      expect(await endGroupStage(organizerId, world.tournamentId)).toEqual({ status: "blocked", error: "2 matches still to play." });
      await play("2/A");
      await play("2/B");
      const ended = await asked(() => endGroupStage(organizerId, world.tournamentId));
      expect(ended).toEqual({ result: { status: "done" }, requests: [paths.state, paths.participants] });
      expect((await people()).filter((p) => p.advanced).map((p) => p.name).sort()).toEqual(["Blader 01", "Blader 02", "Blader 05", "Blader 06"]);
    });

    it("runs the final stage and finalizes, though two group matches were never played", async () => {
      expect(await startFinalStage(organizerId, world.tournamentId)).toEqual({ status: "done" });
      expect((await localMatches()).map(key).sort()).toEqual(["1/A", "1/B", "1/C", "2/A", "2/B", "2/C", "final/A", "final/B", "final/C"]);
      for (const which of ["final/A", "final/B", "final/C"]) expect((await play(which)).result).toEqual({ status: "synced" });
      expect(await finalizeTournament(organizerId, world.tournamentId)).toEqual({ status: "finalized", ranked: 8 });
      expect((await localMatches()).filter((m) => m.state === "pending").map(key).sort()).toEqual(["1/C", "2/C"]);
    });
  });

  describe("with double elimination groups", () => {
    const fake = createFakeTwoStage("double elimination");
    const { organizerId, world, tournament, localMatches, localMatch, people, key, play, clearBattles, asked, paths } = setup(fake);
    const room = async () => buildControlRoom(await tournament(), await people(), await localMatches());
    const labelOf = async (which: string) => {
      const match = await localMatch(which);
      return [...(await room()).ready, ...(await room()).waiting, ...(await room()).completed].find((m) => m.id === match.id)?.roundLabel;
    };

    it("imports both brackets of seven matches and labels their rounds within the group", async () => {
      const matches = await localMatches();
      expect(matches).toHaveLength(14);
      expect(matches.filter((m) => m.groupNumber === 1).map((m) => m.identifier).sort()).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
      expect(matches.every((m) => m.stage === "group")).toBe(true);
      expect(await labelOf("1/A")).toBe("Group A · Winners R1");
      expect(await labelOf("2/B")).toBe("Group B · Winners R1");
    });

    it("moves the winner and the loser on within the group, and learns where they went", async () => {
      const a = await play("1/A");
      expect(a.requests).toEqual([paths.result(a.match.challongeId), paths.matches]);
      const [winnersFinal, losersRound] = [await localMatch("1/C"), await localMatch("1/F")];
      expect(winnersFinal.player1ChallongeId).toBe(a.match.player1ChallongeId);
      expect(losersRound.player1ChallongeId).toBe(a.match.player2ChallongeId);
      expect(await localMatch("1/A")).toMatchObject({ winnerNextChallongeId: winnersFinal.challongeId, loserNextChallongeId: losersRound.challongeId });
      expect(await labelOf("1/C")).toBe("Group A · Winners Final");
      expect(await labelOf("1/F")).toBe("Group A · Losers R1");
    });

    it("asks before a corrected winner erases a later result of the group, and names it with its group", async () => {
      await play("1/B");
      await play("1/C");
      await clearBattles("1/A");
      const corrected = await play("1/A", 2);
      expect(corrected).toMatchObject({ result: { status: "needs_confirmation", affected: ["Group A · Winners Final · C (4 - 1)"] }, requests: [] });

      const confirmed = await asked(() => submitResult(organizerId, corrected.match.id, { confirmDestructive: true }));
      expect(confirmed.result).toEqual({ status: "synced" });
      expect(confirmed.requests).toEqual([paths.result(corrected.match.challongeId), paths.matches]);
      // The winners final is to be played again, by the other player of A.
      expect(await localMatch("1/C")).toMatchObject({ state: "open", winnerChallongeId: null, player1ChallongeId: corrected.match.player2ChallongeId });
      expect(await activeBattles((await localMatch("1/C")).id)).toEqual([]);
    });

    it("stops a group at its losers final: the grand final has its players and stays closed", async () => {
      for (const which of ["1/C", "1/F", "1/G"]) expect((await play(which)).result).toEqual({ status: "synced" });
      expect(await labelOf("1/G")).toBe("Group A · Losers Final");
      const grandFinal = await localMatch("1/D");
      expect(grandFinal).toMatchObject({ state: "pending" });
      expect(grandFinal.player1ChallongeId && grandFinal.player2ChallongeId).toBeTruthy();
      const now = await room();
      expect(now.ready.every((m) => m.roundLabel.startsWith("Group B"))).toBe(true);
      expect(now.waiting).toEqual([]);
    });

    it("ends the group stage with both grand finals unplayed, and starts the final stage", async () => {
      for (const which of ["2/A", "2/B", "2/C", "2/F", "2/G"]) expect((await play(which)).result).toEqual({ status: "synced" });
      expect(await endGroupStage(organizerId, world.tournamentId)).toEqual({ status: "done" });
      expect((await people()).filter((p) => p.advanced)).toHaveLength(4);
      expect(await startFinalStage(organizerId, world.tournamentId)).toEqual({ status: "done" });
      const matches = await localMatches();
      expect(matches.filter((m) => m.stage === "final").map(key).sort()).toEqual(["final/A", "final/B", "final/C"]);
      expect(matches.filter((m) => m.stage === "group" && m.state === "pending").map(key).sort()).toEqual(["1/D", "1/E", "2/D", "2/E"]);
      // The final stage is a single elimination bracket, whatever the groups were.
      const first = (await room()).ready[0];
      expect(first.roundLabel).toBe("Round 1");
    });
  });

  // Refused at import until spike S20 has played one on the real Challonge; the switch lets them in.
  describe("with a round robin final stage", () => {
    const fake = createFakeTwoStage("round robin", "round robin");
    const { organizerId, world, tournament, localMatches, localMatch, people, play, asked, paths } = setup(fake, { unverifiedFinalStage: true });
    const finalStage = async () => (await localMatches()).filter((m) => m.stage === "final").map((m) => `${m.identifier}:r${m.round}:${m.state}`).sort();

    it("imports with the round robin as the format of the final stage", async () => {
      expect(await tournament()).toMatchObject({ tournamentType: "round robin", groupStage: true, groupStageType: "round robin", swissRounds: null });
    });

    it("starts the final stage with every match of its round robin open, labelled by round", async () => {
      for (const which of ["1/A", "1/B", "1/C", "2/A", "2/B", "2/C"]) expect((await play(which)).result).toEqual({ status: "synced" });
      expect(await endGroupStage(organizerId, world.tournamentId)).toEqual({ status: "done" });
      const started = await asked(() => startFinalStage(organizerId, world.tournamentId));
      expect(started).toEqual({ result: { status: "done" }, requests: [paths.state, paths.matches] });
      expect(await finalStage()).toEqual(["A:r1:open", "B:r1:open", "C:r2:open", "D:r2:open", "E:r3:open", "F:r3:open"]);
      const room = buildControlRoom(await tournament(), await people(), await localMatches());
      expect(room.ready.map((m) => m.roundLabel)).toEqual(["Round 1", "Round 1", "Round 2", "Round 2", "Round 3", "Round 3"]);
    });

    it("sends a final-stage result in 1 request, and gives no match the finals rules", async () => {
      const a = await play("final/A");
      expect(a.result).toEqual({ status: "synced" });
      expect(a.requests).toEqual([paths.result(a.match.challongeId)]);
      const now = await tournament();
      for (const which of ["final/A", "final/F"]) expect(await isFinalsMatch(now, await localMatch(which))).toBe(false);
    });

    it("finalizes in 5 requests once the round robin is played, and places everyone", async () => {
      for (const which of ["final/B", "final/C", "final/D", "final/E", "final/F"]) expect((await play(which)).result).toEqual({ status: "synced" });
      const usage = await monthlyUsage(world.connectionId);
      expect(await finalizeTournament(organizerId, world.tournamentId)).toEqual({ status: "finalized", ranked: 6 });
      expect(await monthlyUsage(world.connectionId)).toBe(usage + 5);
      const ranks = (await people()).map((p) => `${p.name}:${p.finalRank}`).sort();
      expect(ranks).toEqual(["Blader 01:1", "Blader 02:3", "Blader 03:5", "Blader 04:2", "Blader 05:4", "Blader 06:5"]);
    });
  });

  describe("with a Swiss final stage", () => {
    const fake = createFakeTwoStage("round robin", "swiss");
    const { organizerId, world, tournament, localMatches, play, asked, paths } = setup(fake, { unverifiedFinalStage: true });
    const finalStage = async () => (await localMatches()).filter((m) => m.stage === "final").map((m) => `${m.identifier}:r${m.round}:${m.state}`).sort();

    it("imports with the number of rounds of the final stage", async () => {
      expect(await tournament()).toMatchObject({ tournamentType: "swiss", groupStageType: "round robin", swissRounds: 2 });
    });

    it("starts the final stage with its first round only", async () => {
      for (const which of ["1/A", "1/B", "1/C", "2/A", "2/B", "2/C"]) await play(which);
      expect(await endGroupStage(organizerId, world.tournamentId)).toEqual({ status: "done" });
      expect(await startFinalStage(organizerId, world.tournamentId)).toEqual({ status: "done" });
      expect(await finalStage()).toEqual(["A:r1:open", "B:r1:open"]);
    });

    it("reads its next round again when Challonge is late, not fooled by the groups' later rounds", async () => {
      const a = await play("final/A");
      expect(a.requests).toEqual([paths.result(a.match.challongeId)]);
      fake.state.lateReads = 1;
      const b = await play("final/B");
      fake.state.lateReads = 0;
      // The groups played rounds 2 and 3 with these players; only the final stage's round 2 counts.
      expect(b.requests).toEqual([paths.result(b.match.challongeId), paths.matches, paths.matches]);
      expect(b.result).toEqual({ status: "synced" });
      expect(await finalStage()).toEqual(["A:r1:complete", "B:r1:complete", "C:r2:open", "D:r2:open"]);
    });

    it("reads nothing after its last round, and finalizes in 5 requests", async () => {
      await play("final/C");
      const d = await play("final/D");
      expect(d.requests).toEqual([paths.result(d.match.challongeId)]);
      const finalized = await asked(() => finalizeTournament(organizerId, world.tournamentId));
      expect(finalized.result).toEqual({ status: "finalized", ranked: 6 });
      expect(finalized.requests).toHaveLength(5);
    });
  });
});
