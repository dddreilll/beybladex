import "server-only";
import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import { after } from "next/server";
import { challongeClientFor } from "@/lib/challonge/connection";
import { describeChallongeError } from "@/lib/challonge/describe-error";
import { db } from "@/lib/db";
import { battles, judgeScreens, matches, stadiums, tournaments, type Match, type Tournament } from "@/lib/db/schema";
import { dispatchNotifications, dispatchRecall } from "@/lib/push";
import { planQueue, type CallStatus } from "@/lib/queue";

type Executor = Pick<typeof db, "select" | "update" | "insert" | "delete">;

/**
 * Sends "on deck" / "you're up" pushes once the current request has finished, i.e. after the
 * surrounding transaction has committed. Outside a request (tests, scripts) this is a no-op and
 * the caller runs dispatchNotifications itself.
 */
function scheduleNotifications(tournamentId: string) {
  try {
    after(() => dispatchNotifications(tournamentId).catch((error) => console.error("Push dispatch failed", error)));
  } catch {}
}

/** Tells polling boards and control rooms that something changed. */
export async function bumpBoard(executor: Pick<typeof db, "update">, tournamentId: string) {
  await executor
    .update(tournaments)
    .set({ boardVersion: sql`${tournaments.boardVersion} + 1` })
    .where(eq(tournaments.id, tournamentId));
}

/**
 * Re-plans the stadium queue and applies the changes. Runs under a lock on the tournament row so
 * concurrent results, taps and organizer actions can't double-assign a stadium.
 */
export async function reconcileQueue(
  tournamentId: string,
  executor?: Executor,
  options: { skip?: string[] } = {},
): Promise<number> {
  const run = async (tx: Executor) => {
    const [tournament] = await tx
      .select({ autoCall: tournaments.autoCall, autoOnDeck: tournaments.autoOnDeck })
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId))
      .for("update");
    if (!tournament) return 0;

    const [stadiumRows, matchRows] = await Promise.all([
      tx.select().from(stadiums).where(eq(stadiums.tournamentId, tournamentId)),
      tx.select().from(matches).where(eq(matches.tournamentId, tournamentId)),
    ]);
    const changes = planQueue(
      stadiumRows,
      matchRows.map((m) => ({
        id: m.id,
        state: m.state,
        player1: m.player1ChallongeId,
        player2: m.player2ChallongeId,
        playOrder: m.suggestedPlayOrder,
        group: m.groupNumber,
        stadiumId: m.stadiumId,
        callStatus: m.callStatus,
        held: m.held,
      })),
      { autoCall: tournament.autoCall, autoOnDeck: tournament.autoOnDeck, skip: options.skip },
    );

    const now = new Date();
    for (const change of changes) {
      await tx
        .update(matches)
        .set({
          stadiumId: change.stadiumId,
          callStatus: change.callStatus,
          calledAt: change.callStatus === "called" ? now : change.callStatus === "playing" ? undefined : null,
          ...(change.callStatus === "called" ? { callCount: 1 } : {}),
          ...(change.callStatus === "none" || change.callStatus === "on_deck" ? { playingAt: null, callCount: 0 } : {}),
          // Back in the queue: a later call must notify the players again.
          ...(change.callStatus === "none" ? { notifiedStatus: null } : {}),
        })
        .where(eq(matches.id, change.matchId));
    }
    await bumpBoard(tx, tournamentId);
    scheduleNotifications(tournamentId);
    return changes.length;
  };
  return executor ? run(executor) : db.transaction((tx) => run(tx));
}

/** Shown wherever a start is refused because nobody is judging the stadium. */
export const NO_JUDGE = "This stadium has no judge yet.";

/** A stadium's judge is an approved tablet, or the organizer judging it themselves. */
export async function stadiumHasJudge(executor: Pick<typeof db, "select">, stadiumId: string | null): Promise<boolean> {
  if (!stadiumId) return false;
  const [row] = await executor
    .select({ id: judgeScreens.id })
    .from(judgeScreens)
    .where(and(eq(judgeScreens.stadiumId, stadiumId), eq(judgeScreens.status, "approved")))
    .limit(1);
  return Boolean(row);
}

/**
 * Tells Challonge a match is being played, when the tournament asks for that (1 request).
 * Returns a message if Challonge couldn't be told; the match has started here either way.
 */
export async function markUnderway(organizerId: string, tournament: Tournament, match: Match): Promise<string | undefined> {
  if (!tournament.markUnderway || match.underwayAt) return undefined;
  try {
    const { client } = await challongeClientFor(organizerId, { communityId: tournament.communityId });
    await client.put(
      `/tournaments/${encodeURIComponent(tournament.challongeId)}/matches/${encodeURIComponent(match.challongeId)}/change_state.json`,
      { data: { type: "MatchState", attributes: { state: "mark_as_underway" } } },
    );
    await db.update(matches).set({ underwayAt: new Date() }).where(eq(matches.id, match.id));
    return undefined;
  } catch (error) {
    return `Started here, but Challonge wasn't updated: ${describeChallongeError(error)}`;
  }
}

export async function ownedTournament(organizerId: string, tournamentId: string) {
  const [row] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.id, tournamentId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  return row ?? null;
}

async function ownedMatch(organizerId: string, matchId: string) {
  const [row] = await db
    .select({ match: matches, tournament: tournaments })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(and(eq(matches.id, matchId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  return row ?? null;
}

export async function addStadium(organizerId: string, tournamentId: string) {
  if (!(await ownedTournament(organizerId, tournamentId))) return false;
  await db.transaction(async (tx) => {
    const [{ last }] = await tx
      .select({ last: max(stadiums.position) })
      .from(stadiums)
      .where(eq(stadiums.tournamentId, tournamentId));
    const position = (last ?? 0) + 1;
    await tx.insert(stadiums).values({ tournamentId, name: `Stadium ${position}`, position });
    await reconcileQueue(tournamentId, tx);
  });
  return true;
}

export async function renameStadium(organizerId: string, stadiumId: string, name: string) {
  const [row] = await db
    .select({ tournamentId: stadiums.tournamentId })
    .from(stadiums)
    .innerJoin(tournaments, eq(tournaments.id, stadiums.tournamentId))
    .where(and(eq(stadiums.id, stadiumId), eq(tournaments.organizerId, organizerId)));
  if (!row) return false;
  await db.update(stadiums).set({ name }).where(eq(stadiums.id, stadiumId));
  await bumpBoard(db, row.tournamentId);
  return true;
}

/** Removing a stadium sends its matches back to the queue (FK is ON DELETE SET NULL). */
export async function removeStadium(organizerId: string, stadiumId: string) {
  const [row] = await db
    .select({ tournamentId: stadiums.tournamentId })
    .from(stadiums)
    .innerJoin(tournaments, eq(tournaments.id, stadiums.tournamentId))
    .where(and(eq(stadiums.id, stadiumId), eq(tournaments.organizerId, organizerId)));
  if (!row) return false;
  await db.transaction(async (tx) => {
    await tx.delete(stadiums).where(eq(stadiums.id, stadiumId));
    await reconcileQueue(row.tournamentId, tx);
  });
  return true;
}

export async function listStadiums(tournamentId: string) {
  return db.select().from(stadiums).where(eq(stadiums.tournamentId, tournamentId)).orderBy(asc(stadiums.position));
}

/** Manually calls a stadium's on-deck match (needed when auto-call is off). */
export async function callOnDeck(organizerId: string, stadiumId: string) {
  return db.transaction(async (tx) => {
    const [stadium] = await tx
      .select({ id: stadiums.id, tournamentId: stadiums.tournamentId })
      .from(stadiums)
      .innerJoin(tournaments, eq(tournaments.id, stadiums.tournamentId))
      .where(and(eq(stadiums.id, stadiumId), eq(tournaments.organizerId, organizerId)));
    if (!stadium) return { error: "Stadium not found." };
    await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, stadium.tournamentId)).for("update");

    const here = await tx.select().from(matches).where(eq(matches.stadiumId, stadiumId));
    if (here.some((m) => m.callStatus === "called" || m.callStatus === "playing")) {
      return { error: "This stadium still has a match. Finish or requeue it first." };
    }
    const onDeck = here.find((m) => m.callStatus === "on_deck");
    if (!onDeck) return { error: "Nothing is on deck here." };
    await tx.update(matches).set({ callStatus: "called", calledAt: new Date(), callCount: 1 }).where(eq(matches.id, onDeck.id));
    await reconcileQueue(stadium.tournamentId, tx);
    return {};
  });
}

export const RECALL_COOLDOWN_MS = 15_000;

/**
 * Re-announces a called match whose players haven't shown up. The match stays where it is; the
 * new call time makes boards announce it again ("Second call"), and both players get another push.
 */
export async function recallMatch(organizerId: string, matchId: string): Promise<{ error?: string; callNumber?: number }> {
  const found = await ownedMatch(organizerId, matchId);
  if (!found) return { error: "Match not found." };
  const { match, tournament } = found;
  if (match.callStatus !== "called") return { error: "Only a called match that hasn't started can be recalled." };
  const sinceLast = match.calledAt ? Date.now() - match.calledAt.getTime() : RECALL_COOLDOWN_MS;
  if (sinceLast < RECALL_COOLDOWN_MS) {
    return { error: `Just called. Wait ${Math.ceil((RECALL_COOLDOWN_MS - sinceLast) / 1000)}s before recalling.` };
  }

  // Conditional on the status we checked, so a recall can't race a start or a hold.
  const [updated] = await db
    .update(matches)
    .set({ callCount: sql`${matches.callCount} + 1`, calledAt: new Date() })
    .where(and(eq(matches.id, matchId), eq(matches.callStatus, "called")))
    .returning({ callCount: matches.callCount });
  if (!updated) return { error: "The match is no longer waiting for its players." };
  await bumpBoard(db, tournament.id);
  try {
    after(() => dispatchRecall(matchId).catch((error) => console.error("Recall push failed", error)));
  } catch {}
  return { callNumber: updated.callCount };
}

/** Puts a ready match on deck at a stadium by hand (only into an empty on-deck slot). */
export async function placeOnDeck(organizerId: string, matchId: string, stadiumId: string): Promise<{ error?: string }> {
  const found = await ownedMatch(organizerId, matchId);
  if (!found) return { error: "Match not found." };
  const tournamentId = found.tournament.id;

  return db.transaction(async (tx) => {
    await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, tournamentId)).for("update");
    const [all, [stadium]] = await Promise.all([
      tx.select().from(matches).where(eq(matches.tournamentId, tournamentId)),
      tx.select().from(stadiums).where(and(eq(stadiums.id, stadiumId), eq(stadiums.tournamentId, tournamentId))),
    ]);
    const match = all.find((m) => m.id === matchId);
    if (!stadium?.active) return { error: "Stadium not found." };
    if (!match || match.state !== "open" || !match.player1ChallongeId || !match.player2ChallongeId) {
      return { error: "This match isn't ready to be played." };
    }
    if (match.callStatus !== "none") return { error: "This match is already at a stadium." };
    if (match.held) return { error: "This match is on hold. Release it first." };
    if (all.some((m) => m.stadiumId === stadiumId && m.callStatus === "on_deck")) {
      return { error: `${stadium.name} already has a match on deck. Send it back to the queue first.` };
    }
    const players = [match.player1ChallongeId, match.player2ChallongeId];
    const busy = all.some(
      (m) => m.id !== matchId && m.callStatus !== "none" && players.some((p) => p === m.player1ChallongeId || p === m.player2ChallongeId),
    );
    if (busy) return { error: "One of these players is already at a stadium." };

    await tx.update(matches).set({ stadiumId, callStatus: "on_deck" }).where(eq(matches.id, matchId));
    await reconcileQueue(tournamentId, tx);
    return {};
  });
}

/**
 * Sends an on-deck match back to the queue. With automatic filling on, it is skipped for this
 * pass (the next ready match takes the slot) and is eligible again when another slot opens.
 */
export async function backToQueue(organizerId: string, matchId: string): Promise<{ error?: string }> {
  const found = await ownedMatch(organizerId, matchId);
  if (!found) return { error: "Match not found." };
  if (found.match.callStatus !== "on_deck") return { error: "Only an on-deck match can be sent back to the queue." };
  await db.transaction(async (tx) => {
    await tx
      .update(matches)
      .set({ stadiumId: null, callStatus: "none", notifiedStatus: null })
      .where(and(eq(matches.id, matchId), eq(matches.callStatus, "on_deck")));
    await reconcileQueue(found.tournament.id, tx, { skip: [matchId] });
  });
  return {};
}

/**
 * Moves an on-deck match to another stadium whose on-deck slot is empty. Its players are told the
 * new stadium, and the queue is planned again: the stadium it left may take the next ready match,
 * and a free stadium that calls by itself calls it.
 */
export async function moveOnDeck(organizerId: string, matchId: string, stadiumId: string): Promise<{ error?: string }> {
  const found = await ownedMatch(organizerId, matchId);
  if (!found) return { error: "Match not found." };
  const tournamentId = found.tournament.id;

  return db.transaction(async (tx) => {
    await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, tournamentId)).for("update");
    const [all, [stadium]] = await Promise.all([
      tx.select().from(matches).where(eq(matches.tournamentId, tournamentId)),
      tx.select().from(stadiums).where(and(eq(stadiums.id, stadiumId), eq(stadiums.tournamentId, tournamentId))),
    ]);
    const match = all.find((m) => m.id === matchId);
    if (!stadium?.active) return { error: "Stadium not found." };
    if (match?.callStatus !== "on_deck") return { error: "Only an on-deck match can be moved." };
    if (match.stadiumId === stadiumId) return { error: `This match is already on deck at ${stadium.name}.` };
    if (all.some((m) => m.stadiumId === stadiumId && m.callStatus === "on_deck")) {
      return { error: `${stadium.name} already has a match on deck. Send it back to the queue first.` };
    }
    // Not yet announced at this stadium: the next notification pass tells the players where to go.
    await tx.update(matches).set({ stadiumId, notifiedStatus: null }).where(eq(matches.id, matchId));
    await reconcileQueue(tournamentId, tx);
    return {};
  });
}

/** Removes Challonge's "underway" mark from a match that stopped being played (1 request). */
async function unmarkUnderway(organizerId: string, found: NonNullable<Awaited<ReturnType<typeof ownedMatch>>>): Promise<string | undefined> {
  const { match, tournament } = found;
  if (!match.underwayAt) return undefined;
  try {
    const { client } = await challongeClientFor(organizerId, { communityId: tournament.communityId });
    await client.put(
      `/tournaments/${encodeURIComponent(tournament.challongeId)}/matches/${encodeURIComponent(match.challongeId)}/change_state.json`,
      { data: { type: "MatchState", attributes: { state: "unmark_as_underway" } } },
    );
    await db.update(matches).set({ underwayAt: null }).where(eq(matches.id, match.id));
    return undefined;
  } catch (error) {
    return `Done here, but Challonge still shows the match as underway: ${describeChallongeError(error)}`;
  }
}

/** Pauses a match that is called or being played: battles are kept, and it waits as HELD until released. */
export async function holdMatch(organizerId: string, matchId: string): Promise<{ error?: string; warning?: string }> {
  const found = await ownedMatch(organizerId, matchId);
  if (!found) return { error: "Match not found." };
  await setHeld(organizerId, matchId, true);
  return { warning: await unmarkUnderway(organizerId, found) };
}

/**
 * Cancels a match in progress: its battles are voided (kept in the log), the rules snapshot is
 * dropped, and it waits as HELD at 0–0 until released.
 */
export async function cancelMatch(organizerId: string, matchId: string): Promise<{ error?: string; warning?: string; voided?: number }> {
  const found = await ownedMatch(organizerId, matchId);
  if (!found) return { error: "Match not found." };
  if (found.match.callStatus !== "called" && found.match.callStatus !== "playing") {
    return { error: "Only a match that is called or being played can be cancelled." };
  }
  const voided = await db.transaction(async (tx) => {
    const rows = await tx
      .update(battles)
      .set({ voidedAt: new Date(), voidReason: "cancelled" })
      .where(and(eq(battles.matchId, matchId), isNull(battles.voidedAt)))
      .returning({ id: battles.id });
    await tx
      .update(matches)
      .set({ held: true, stadiumId: null, callStatus: "none", calledAt: null, playingAt: null, notifiedStatus: null, callCount: 0, ruleSnapshot: null })
      .where(eq(matches.id, matchId));
    await reconcileQueue(found.tournament.id, tx);
    return rows.length;
  });
  return { voided, warning: await unmarkUnderway(organizerId, found) };
}

/**
 * Marks a called match as being played, from the control room; optionally tells Challonge
 * (1 request). Refused while nobody is judging the stadium. The judge's pad starts a match
 * through its own "start" operation (lib/battles.ts), under the same rule.
 */
export async function startMatch(organizerId: string, matchId: string): Promise<{ error?: string; warning?: string }> {
  const found = await ownedMatch(organizerId, matchId);
  if (!found) return { error: "Match not found." };
  const { match, tournament } = found;
  if (match.callStatus !== "called" && match.callStatus !== "playing") return { error: "Only a called match can start." };
  if (match.callStatus === "called" && !(await stadiumHasJudge(db, match.stadiumId))) {
    return { error: `${NO_JUDGE} Approve a judge's device for it, or choose Judge here myself.` };
  }
  await setPlaying(match.id, tournament.id);
  return { warning: await markUnderway(organizerId, tournament, match) };
}

export async function setPlaying(matchId: string, tournamentId: string, executor: Pick<typeof db, "update"> = db) {
  await executor
    .update(matches)
    .set({ callStatus: "playing", playingAt: new Date() })
    .where(and(eq(matches.id, matchId), eq(matches.callStatus, "called")));
  await bumpBoard(executor, tournamentId);
}

/** Hold takes a match out of the queue (e.g. a no-show); release puts it back. */
export async function setHeld(organizerId: string, matchId: string, held: boolean) {
  const found = await ownedMatch(organizerId, matchId);
  if (!found) return false;
  await db.transaction(async (tx) => {
    const status: Partial<{ stadiumId: null; callStatus: CallStatus; calledAt: null; playingAt: null; notifiedStatus: null; callCount: number }> =
      held ? { stadiumId: null, callStatus: "none", calledAt: null, playingAt: null, notifiedStatus: null, callCount: 0 } : {};
    await tx.update(matches).set({ held, ...status }).where(eq(matches.id, matchId));
    await reconcileQueue(found.tournament.id, tx);
  });
  return true;
}

export async function updateVenueSettings(
  organizerId: string,
  tournamentId: string,
  settings: { autoCall: boolean; markUnderway: boolean; autoOnDeck?: boolean; boardLimit?: number },
) {
  if (!(await ownedTournament(organizerId, tournamentId))) return false;
  await db.transaction(async (tx) => {
    await tx.update(tournaments).set(settings).where(eq(tournaments.id, tournamentId));
    await reconcileQueue(tournamentId, tx);
  });
  return true;
}
