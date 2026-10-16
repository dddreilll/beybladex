import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { activeBattles, matchForOrganizer, voidBattlesOfMatches } from "@/lib/battles";
import { db } from "@/lib/db";
import { matches, syncOutbox, tournaments, type Match, type Tournament } from "@/lib/db/schema";
import { rulesFor } from "@/lib/rules";
import { reconcileQueue } from "@/lib/venue";
import { challongeEntries, scoreMatch } from "@/lib/scoring/engine";
import { mapMatch, roundLabeller } from "./map";
import { challongeClientFor } from "./connection";
import { describeChallongeError } from "./describe-error";
import { findResetMatches, learnProgression, type MatchSlots } from "./progression";
import { isElimination, isSwiss, stagePhase, stageType } from "./support";
import { replaceMatches } from "./sync";
import type { MatchResource, SingleResponse } from "./types";

const IN_FLIGHT_TIMEOUT_MS = 2 * 60 * 1000;

export type SubmitOutcome =
  | { status: "synced"; warning?: string }
  | { status: "needs_confirmation"; affected: string[] }
  | { status: "invalid" | "failed" | "conflict"; error: string };

const slots = (rows: Pick<Match, "challongeId" | "state" | "player1ChallongeId" | "player2ChallongeId">[]): MatchSlots[] =>
  rows.map((r) => ({
    challongeId: r.challongeId,
    state: r.state,
    player1ChallongeId: r.player1ChallongeId,
    player2ChallongeId: r.player2ChallongeId,
  }));

/**
 * Completed matches a winner change would wipe on Challonge (spike S4b). Uses the learned bracket
 * links; for matches reported outside this app, falls back to later completed matches either
 * player has already played.
 */
function downstreamCompleted(match: Match, all: Match[]): Match[] {
  const learned = [match.winnerNextChallongeId, match.loserNextChallongeId].filter(Boolean);
  if (learned.length) return all.filter((m) => learned.includes(m.challongeId) && m.state === "complete");
  const players = [match.player1ChallongeId, match.player2ChallongeId];
  return all.filter(
    (m) =>
      m.id !== match.id &&
      // Play order starts again in each stage of a two-stage tournament.
      m.stage === match.stage &&
      m.state === "complete" &&
      (m.suggestedPlayOrder ?? 0) > (match.suggestedPlayOrder ?? 0) &&
      players.some((p) => p && (m.player1ChallongeId === p || m.player2ChallongeId === p)),
  );
}

export async function submitResult(
  organizerId: string,
  matchId: string,
  options: { confirmDestructive?: boolean } = {},
): Promise<SubmitOutcome> {
  const found = await matchForOrganizer(organizerId, matchId);
  if (!found) return { status: "invalid", error: "Match not found." };
  const { match, tournament } = found;
  if (!match.player1ChallongeId || !match.player2ChallongeId) {
    return { status: "invalid", error: "Both players must be known before reporting." };
  }
  // Challonge refuses a group result once the group stage has ended (spike S17), so it isn't sent.
  if (match.stage === "group" && stagePhase(tournament) !== "groups") {
    return { status: "invalid", error: "The group stage has ended on Challonge, so its results can't be changed." };
  }

  const rules = await rulesFor(tournament, match);
  const score = scoreMatch(rules, await activeBattles(matchId));
  if (!score.winner) return { status: "invalid", error: "The match isn't decided yet." };

  const players = { 1: match.player1ChallongeId, 2: match.player2ChallongeId };
  const winnerId = players[score.winner];
  const loserId = players[score.winner === 1 ? 2 : 1];
  const isCorrection = match.state === "complete";

  // Only a bracket can lose later results to a corrected winner. In round robin and Swiss nothing else changes.
  if (isElimination(stageType(tournament, match.stage)) && isCorrection && match.winnerChallongeId !== winnerId && !options.confirmDestructive) {
    const all = await db.select().from(matches).where(eq(matches.tournamentId, tournament.id));
    const affected = downstreamCompleted(match, all);
    if (affected.length) {
      const labelOf = roundLabeller(tournament, all);
      return {
        status: "needs_confirmation",
        affected: affected.map((m) => `${labelOf(m)} · ${m.identifier}${m.scores ? ` (${m.scores})` : ""}`),
      };
    }
  }

  // One result in flight per match: lock the match row while creating the outbox entry.
  const outboxId = await db.transaction(async (tx) => {
    await tx.select({ id: matches.id }).from(matches).where(eq(matches.id, matchId)).for("update");
    const [inFlight] = await tx
      .select({ id: syncOutbox.id })
      .from(syncOutbox)
      .where(
        and(
          eq(syncOutbox.matchId, matchId),
          eq(syncOutbox.status, "pending"),
          // A send that crashed mid-way shouldn't block the match forever.
          gt(syncOutbox.createdAt, new Date(Date.now() - IN_FLIGHT_TIMEOUT_MS)),
        ),
      )
      .limit(1);
    if (inFlight) return null;
    const [row] = await tx
      .insert(syncOutbox)
      .values({
        tournamentId: tournament.id,
        matchId,
        kind: isCorrection ? "correct_result" : "report_result",
        payload: { winnerId, loserId, entries: challongeEntries(rules, score, players) },
        createdBy: organizerId,
      })
      .returning({ id: syncOutbox.id });
    return row.id;
  });
  if (!outboxId) return { status: "conflict", error: "This result is already being sent to Challonge." };

  return pushOutbox(organizerId, outboxId);
}

/**
 * How long Challonge is given to pair the next Swiss round before it is read, and before it is read
 * a second time. Challonge pairs it after it has answered the round's last result: 35 to 300 ms
 * after in every measurement, and once later than a read sent straight away (spikes S8, S10).
 */
export const pairingWait = { firstMs: 1000, secondMs: 2000 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * After the last result of a Swiss round, reads the round Challonge pairs next: 1 request, or 2 if
 * the round isn't there the first time. Returns a warning for the pad when it still isn't, or when
 * it couldn't be read; null otherwise, and when no round is due.
 * In a group stage each group has its own rounds, paired when that group's round ends (spike S17),
 * and Challonge doesn't say how many there are: after a group's last round both reads find nothing.
 */
async function readNextRound(
  client: Awaited<ReturnType<typeof challongeClientFor>>["client"],
  tournament: Tournament,
  match: Match,
): Promise<string | null> {
  const all = await db.select().from(matches).where(eq(matches.tournamentId, tournament.id));
  // The matches whose rounds this one's belongs to: its group's, or its whole stage when the groups aren't known.
  const rows = all.filter((r) => r.stage === match.stage && (match.groupNumber === null || r.groupNumber === match.groupNumber));
  const players = new Set(rows.flatMap((r) => [r.player1ChallongeId, r.player2ChallongeId]).filter((p): p is string => Boolean(p)));
  const rounds = match.stage === "group" ? null : tournament.swissRounds;
  const lastRound = Math.max(...rows.map((r) => r.round));
  const roundOver = match.round === lastRound && rows.filter((r) => r.round === match.round).every((r) => r.state === "complete");
  if (!roundOver || (rounds !== null && lastRound >= rounds)) return null;

  try {
    for (const wait of [pairingWait.firstMs, pairingWait.secondMs]) {
      await sleep(wait);
      const list = await client.listAll<MatchResource>(`/tournaments/${encodeURIComponent(tournament.challongeId)}/matches.json`);
      if (list.notModified) throw new Error("Unexpected 304 after reporting.");
      const paired = await db.transaction(async (tx) => {
        await replaceMatches(tx, tournament.id, list.data, tournament);
        await tx.update(tournaments).set({ matchesEtag: list.etag, lastSyncedAt: new Date() }).where(eq(tournaments.id, tournament.id));
        await reconcileQueue(tournament.id, tx);
        // Asked of the stored matches, which have their stage: the groups' later rounds are no round
        // of a Swiss final stage, and another group may be a round ahead. The new round is one of
        // this stage that these players are in.
        const stored = await tx.select().from(matches).where(and(eq(matches.tournamentId, tournament.id), eq(matches.stage, match.stage)));
        return stored.some((m) => m.round > lastRound && [m.player1ChallongeId, m.player2ChallongeId].some((p) => p !== null && players.has(p)));
      });
      if (paired) return null;
    }
  } catch (error) {
    return `Saved on Challonge, but the next round couldn't be read (${describeChallongeError(error)}). Use Resync.`;
  }
  // Without the number of rounds there is no telling a late round from the end of the tournament or the group.
  if (rounds === null) return null;
  return `Saved on Challonge. Round ${lastRound + 1} isn't paired there yet. Use Resync in a moment.`;
}

/**
 * Sends one outbox entry to Challonge and verifies it was accepted. In a bracket it then reads the
 * matches again, because the result moved players on (2 requests). In a round robin or a Swiss
 * round it doesn't: the answer to the result is all that changed (1 request). The last result of
 * a Swiss round is followed by a read of the next round. The format is that of the match's stage.
 */
export async function pushOutbox(organizerId: string, outboxId: string): Promise<SubmitOutcome> {
  const [row] = await db
    .select({ outbox: syncOutbox, match: matches, tournament: tournaments })
    .from(syncOutbox)
    .innerJoin(matches, eq(matches.id, syncOutbox.matchId))
    .innerJoin(tournaments, eq(tournaments.id, syncOutbox.tournamentId))
    .where(and(eq(syncOutbox.id, outboxId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  if (!row) return { status: "invalid", error: "Nothing to send." };
  const { outbox, match, tournament } = row;

  const finish = async (status: "done" | "failed" | "conflict", lastError: string | null) => {
    await db
      .update(syncOutbox)
      .set({ status, lastError, attempts: outbox.attempts + 1 })
      .where(eq(syncOutbox.id, outbox.id));
  };

  let client: Awaited<ReturnType<typeof challongeClientFor>>["client"];
  let accepted: boolean;
  let acceptedState: string | undefined;
  let saved: MatchResource | undefined;
  try {
    ({ client } = await challongeClientFor(organizerId, { communityId: tournament.communityId }));
    const res = await client.put<SingleResponse<MatchResource>>(
      `/tournaments/${encodeURIComponent(tournament.challongeId)}/matches/${encodeURIComponent(match.challongeId)}.json`,
      { data: { type: "Match", attributes: { match: outbox.payload.entries } } },
    );
    // Spike S4: Challonge can answer 200 without applying the result (e.g. it ignores ties).
    saved = res?.data;
    acceptedState = saved?.attributes?.state;
    accepted = acceptedState === "complete" && String(saved.attributes.winner_id) === outbox.payload.winnerId;
  } catch (error) {
    const message = describeChallongeError(error);
    await finish("failed", message);
    return { status: "failed", error: message };
  }

  const conflictMessage = accepted
    ? null
    : `Challonge didn't record this result (match is ${acceptedState ?? "unknown"}). Check the match on Challonge, then resync.`;

  const type = stageType(tournament, match.stage);
  if (!isElimination(type)) {
    if (!accepted || !saved) {
      await finish("conflict", conflictMessage);
      return { status: "conflict", error: conflictMessage! };
    }
    // The match as Challonge answered it. In a round robin or a Swiss round nothing else changes with a result (spike S7).
    const { state, winnerChallongeId, scores, scoreInSets } = mapMatch(saved);
    await db.transaction(async (tx) => {
      await tx.update(matches).set({ state, winnerChallongeId, scores, scoreInSets }).where(eq(matches.id, match.id));
      // Frees the stadium, calls the on-deck match and pulls the next ready match into the queue.
      await reconcileQueue(tournament.id, tx);
    });
    await finish("done", null);
    if (!isSwiss(type)) return { status: "synced" };
    const warning = await readNextRound(client, tournament, match);
    return warning ? { status: "synced", warning } : { status: "synced" };
  }

  // Refresh so the next matches (and anything a correction wiped) show up locally.
  try {
    const before = await db.select().from(matches).where(eq(matches.tournamentId, tournament.id));
    const list = await client.listAll<MatchResource>(`/tournaments/${encodeURIComponent(tournament.challongeId)}/matches.json`);
    if (list.notModified) throw new Error("Unexpected 304 after reporting.");
    const after = list.data.map(mapMatch);

    await db.transaction(async (tx) => {
      await replaceMatches(tx, tournament.id, list.data, tournament);
      await tx
        .update(tournaments)
        .set({ matchesEtag: list.etag, lastSyncedAt: new Date() })
        .where(eq(tournaments.id, tournament.id));

      if (accepted) {
        const learned = learnProgression(slots(before), after, {
          challongeId: match.challongeId,
          winnerId: outbox.payload.winnerId,
          loserId: outbox.payload.loserId,
        });
        await tx
          .update(matches)
          .set({
            winnerNextChallongeId: learned.winnerNext ?? match.winnerNextChallongeId,
            loserNextChallongeId: learned.loserNext ?? match.loserNextChallongeId,
          })
          .where(eq(matches.id, match.id));
      }

      const reset = findResetMatches(slots(before), after, match.challongeId);
      if (reset.length) {
        const ids = before.filter((m) => reset.includes(m.challongeId)).map((m) => m.id);
        await voidBattlesOfMatches(tx, ids, "reset_by_correction");
        await tx.update(matches).set({ ruleSnapshot: null }).where(inArray(matches.id, ids));
      }
      // Frees the stadium, calls the on-deck match and pulls newly ready matches into the queue.
      await reconcileQueue(tournament.id, tx);
    });
  } catch (error) {
    await finish(accepted ? "done" : "conflict", conflictMessage ?? "Result saved on Challonge, but refreshing the bracket failed. Resync.");
    if (!accepted) return { status: "conflict", error: conflictMessage! };
    return { status: "synced", warning: `Saved on Challonge, but the bracket refresh failed (${describeChallongeError(error)}). Use Resync.` };
  }

  if (!accepted) {
    await finish("conflict", conflictMessage);
    return { status: "conflict", error: conflictMessage! };
  }
  await finish("done", null);
  return { status: "synced" };
}
