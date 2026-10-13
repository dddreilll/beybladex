// A Swiss tournament against the real database and a fake Challonge built from spikes S7 to S11:
// rounds that arrive one at a time (and sometimes late), a correction, a player who drops out,
// and a finalize that waits for the last round.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeSwiss } from "./fake-swiss";

const enabled = Boolean(process.env.DATABASE_URL && process.env.APP_ENCRYPTION_KEYS);

describe.skipIf(!enabled)("a Swiss tournament against the database", async () => {
  if (!enabled) return;
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { sql, eq, and } = await import("drizzle-orm");
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const { saveCredentials } = await import("@/lib/challonge/connection");
  const { importTournament, resyncTournament } = await import("@/lib/challonge/sync");
  const { finalizeTournament } = await import("@/lib/challonge/finalize");
  const { monthlyUsage } = await import("@/lib/challonge/budget");
  const { applyBattleOps, activeBattles } = await import("@/lib/battles");
  const { submitResult, pairingWait } = await import("@/lib/challonge/report");
  const { finalizeBlockers } = await import("@/lib/finalize-check");

  const fake = createFakeSwiss();
  // Four rounds, so there are three changes of round to read.
  fake.rounds(4);
  const organizerId = randomUUID();
  let tournamentId: string;
  let connectionId: string;
  const waits = { ...pairingWait };

  const localMatches = () => db.select().from(schema.matches).where(eq(schema.matches.tournamentId, tournamentId));
  const localRound = async (round: number) => (await localMatches()).filter((m) => m.round === round).sort((a, b) => a.identifier.localeCompare(b.identifier));
  const localMatch = async (identifier: string) =>
    (
      await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.tournamentId, tournamentId), eq(schema.matches.identifier, identifier)))
    )[0];
  const add = (kind: string, side: 1 | 2) => ({ op: "add" as const, opId: randomUUID(), kind: kind as "spin", side });
  const matchesPath = `/tournaments/${fake.id}/matches.json`;

  /** Scores a match to `winnerSide` 4–1 via judge-pad ops, sends it, and says what that asked Challonge for. */
  async function play(identifier: string, winnerSide: 1 | 2 = 1) {
    const match = await localMatch(identifier);
    const loser = winnerSide === 1 ? 2 : 1;
    const applied = await applyBattleOps(organizerId, match.id, [add("xtreme", winnerSide), add("spin", loser), add("spin", winnerSide)]);
    expect(applied!.rejected).toEqual([]);
    const from = fake.state.requests.length;
    const result = await submitResult(organizerId, match.id);
    return { match, result, requests: fake.state.requests.slice(from) };
  }
  const put = (challongeId: string) => `PUT /tournaments/${fake.id}/matches/${challongeId}.json`;

  beforeAll(async () => {
    vi.stubGlobal("fetch", fake.fetch);
    // The waits before reading the next round are for the real Challonge.
    Object.assign(pairingWait, { firstMs: 0, secondMs: 0 });
    await db.execute(sql`insert into auth.users (id, email, aud, role, instance_id)
      values (${organizerId}, ${`it-${organizerId}@example.test`}, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`);
    await saveCredentials(organizerId, "client", "secret");
    const [conn] = await db.select().from(schema.challongeConnections).where(eq(schema.challongeConnections.organizerId, organizerId));
    connectionId = conn.id;
    await db
      .update(schema.challongeConnections)
      .set({
        accessTokenEnc: encryptSecret("access-1", `${organizerId}:access_token`),
        refreshTokenEnc: encryptSecret("refresh-1", `${organizerId}:refresh_token`),
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        status: "connected",
      })
      .where(eq(schema.challongeConnections.id, connectionId));
  });

  afterAll(async () => {
    Object.assign(pairingWait, waits);
    await db.execute(sql`delete from auth.users where id = ${organizerId}`);
    vi.unstubAllGlobals();
    await db.$client.end();
  });

  it("imports in 3 requests, with only the first round and the number of rounds", async () => {
    const from = fake.state.requests.length;
    tournamentId = await importTournament(organizerId, fake.slug);
    const [tournament] = await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, tournamentId));
    expect(tournament).toMatchObject({ tournamentType: "swiss", swissRounds: 4, participantsCount: 6 });
    expect((await localMatches()).map((m) => `${m.identifier}:r${m.round}:${m.state}`).sort()).toEqual(["A:r1:open", "B:r1:open", "C:r1:open"]);
    expect(fake.state.requests.slice(from)).toHaveLength(3);
  });

  it("sends a result in the middle of a round in 1 request", async () => {
    const a = await play("A");
    expect(a.result).toEqual({ status: "synced" });
    expect(a.requests).toEqual([put(a.match.challongeId)]);
    const b = await play("B");
    expect(b.requests).toEqual([put(b.match.challongeId)]);
    expect(await localRound(2)).toEqual([]);
  });

  it("reads the next round after the last result of a round: 1 more request", async () => {
    const c = await play("C");
    expect(c.result).toEqual({ status: "synced" });
    expect(c.requests).toEqual([put(c.match.challongeId), `GET ${matchesPath}`]);
    expect((await localRound(2)).map((m) => `${m.identifier}:${m.state}`)).toEqual(["D:open", "E:open", "F:open"]);
  });

  it("reads a second time when Challonge hadn't paired the round yet", async () => {
    fake.state.pairingDelayReads = 1;
    await play("D");
    await play("E");
    const f = await play("F");
    expect(f.result).toEqual({ status: "synced" });
    expect(f.requests).toEqual([put(f.match.challongeId), `GET ${matchesPath}`, `GET ${matchesPath}`]);
    expect((await localRound(3)).map((m) => `${m.identifier}:${m.state}`)).toEqual(["G:open", "H:open", "I:open"]);
  });

  it("corrects a result of an earlier round without asking, and changes that match only", async () => {
    const a = await localMatch("A");
    const battles = await activeBattles(a.id);
    await applyBattleOps(organizerId, a.id, battles.map((b) => ({ op: "void" as const, opId: randomUUID(), targetOpId: b.opId })));
    const laterRounds = async () => [...(await localRound(2)), ...(await localRound(3))].map((m) => `${m.identifier}:${m.state}:${m.player1ChallongeId}v${m.player2ChallongeId}`);
    const before = await laterRounds();

    const corrected = await play("A", 2);

    expect(corrected.result).toEqual({ status: "synced" });
    expect(corrected.requests).toEqual([put(a.challongeId)]);
    expect(await localMatch("A")).toMatchObject({ state: "complete", winnerChallongeId: a.player2ChallongeId, scores: "1 - 4" });
    // Challonge keeps the pairings it made from the old result (spike S7).
    expect(await laterRounds()).toEqual(before);
  });

  it("says so when the next round still isn't there, and Finalize waits for it", async () => {
    // Three reads miss it: the two after the result, and the one Finalize makes.
    fake.state.pairingDelayReads = 3;
    await play("G");
    await play("H");
    const i = await play("I");
    expect(i.result).toEqual({ status: "synced", warning: "Saved on Challonge. Round 4 isn't paired there yet. Use Resync in a moment." });
    expect(i.requests).toEqual([put(i.match.challongeId), `GET ${matchesPath}`, `GET ${matchesPath}`]);
    expect(await localRound(4)).toEqual([]);

    const waiting = "Round 4 of 4 isn't paired on Challonge yet. Resync in a moment.";
    expect(finalizeBlockers({ matches: await localMatches(), unsent: 0, swissRounds: 4 })).toEqual([waiting]);
    expect(await finalizeTournament(organizerId, tournamentId)).toEqual({ status: "blocked", error: waiting });
    expect(fake.state.tournamentStateChanges).toEqual([]);

    const from = fake.state.requests.length;
    expect(await resyncTournament(organizerId, tournamentId)).toEqual({ matchesChanged: true, participantsRefetched: true });
    // The tournament, the matches, and the participants: in Swiss a resync always reads them.
    expect(fake.state.requests.slice(from)).toEqual([`GET /tournaments/${fake.id}.json`, `GET ${matchesPath}`, `GET /tournaments/${fake.id}/participants.json`]);
    expect((await localRound(4)).map((m) => m.state)).toEqual(["open", "open", "open"]);
  });

  it("sees a player who dropped out on challonge.com after a resync, with their match forfeited", async () => {
    const [theirs] = await localRound(4);
    const dropped = theirs.player1ChallongeId!;
    fake.drop(dropped);

    expect(await resyncTournament(organizerId, tournamentId)).toEqual({ matchesChanged: true, participantsRefetched: true });

    const people = await db.select().from(schema.participants).where(eq(schema.participants.tournamentId, tournamentId));
    expect(people).toHaveLength(6);
    expect(people.filter((p) => !p.active).map((p) => p.challongeId)).toEqual([dropped]);
    expect(await localMatch(theirs.identifier)).toMatchObject({ state: "complete", winnerChallongeId: theirs.player2ChallongeId, scores: "0 - 0" });
  });

  it("doesn't read after the last result of the last round, and finalizes in 5 requests", async () => {
    const [first, last] = (await localRound(4)).filter((m) => m.state === "open");
    await play(first.identifier);
    const end = await play(last.identifier);
    expect(end.result).toEqual({ status: "synced" });
    expect(end.requests).toEqual([put(last.challongeId)]);

    const usage = await monthlyUsage(connectionId);
    expect(await finalizeTournament(organizerId, tournamentId)).toEqual({ status: "finalized", ranked: 6 });
    // A resync (the tournament, the matches, the participants), the finalize, and the placements.
    expect(await monthlyUsage(connectionId)).toBe(usage + 5);
    expect(fake.state.tournamentStateChanges).toEqual(["finalize"]);
  });
});
