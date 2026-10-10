import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { activeBattles, matchForOrganizer, voidBattlesOfMatches } from "@/lib/battles";
import { db } from "@/lib/db";
import { matches, syncOutbox, tournaments, type Match } from "@/lib/db/schema";
import { rulesFor } from "@/lib/rules";
import { reconcileQueue } from "@/lib/venue";
import { challongeEntries, scoreMatch } from "@/lib/scoring/engine";
import { roundContext, roundLabel, mapMatch } from "./map";
import { challongeClientFor } from "./connection";
import { describeChallongeError } from "./describe-error";
import { findResetMatches, learnProgression, type MatchSlots } from "./progression";
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

  const rules = await rulesFor(tournament, match);
  const score = scoreMatch(rules, await activeBattles(matchId));
  if (!score.winner) return { status: "invalid", error: "The match isn't decided yet." };

  const players = { 1: match.player1ChallongeId, 2: match.player2ChallongeId };
  const winnerId = players[score.winner];
  const loserId = players[score.winner === 1 ? 2 : 1];
  const isCorrection = match.state === "complete";

  if (isCorrection && match.winnerChallongeId !== winnerId && !options.confirmDestructive) {
    const all = await db.select().from(matches).where(eq(matches.tournamentId, tournament.id));
    const affected = downstreamCompleted(match, all);
    if (affected.length) {
      const ctx = roundContext(tournament.tournamentType, all.map((m) => m.round));
      return {
        status: "needs_confirmation",
        affected: affected.map((m) => `${roundLabel(m.round, ctx)} · ${m.identifier}${m.scores ? ` (${m.scores})` : ""}`),
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

/** Sends one outbox entry to Challonge, verifies it was accepted, then refreshes the bracket (2 requests). */
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
  try {
    ({ client } = await challongeClientFor(organizerId, { communityId: tournament.communityId }));
    const res = await client.put<SingleResponse<MatchResource>>(
      `/tournaments/${encodeURIComponent(tournament.challongeId)}/matches/${encodeURIComponent(match.challongeId)}.json`,
      { data: { type: "Match", attributes: { match: outbox.payload.entries } } },
    );
    // Spike S4: Challonge can answer 200 without applying the result (e.g. it ignores ties).
    acceptedState = res?.data?.attributes?.state;
    accepted = acceptedState === "complete" && String(res.data.attributes.winner_id) === outbox.payload.winnerId;
  } catch (error) {
    const message = describeChallongeError(error);
    await finish("failed", message);
    return { status: "failed", error: message };
  }

  const conflictMessage = accepted
    ? null
    : `Challonge didn't record this result (match is ${acceptedState ?? "unknown"}). Check the match on Challonge, then resync.`;

  // Refresh so the next matches (and anything a correction wiped) show up locally.
  try {
    const before = await db.select().from(matches).where(eq(matches.tournamentId, tournament.id));
    const list = await client.listAll<MatchResource>(`/tournaments/${encodeURIComponent(tournament.challongeId)}/matches.json`);
    if (list.notModified) throw new Error("Unexpected 304 after reporting.");
    const after = list.data.map(mapMatch);

    await db.transaction(async (tx) => {
      await replaceMatches(tx, tournament.id, list.data);
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
