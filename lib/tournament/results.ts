import "server-only";
import { eq, inArray } from "drizzle-orm";
import { correctWinner, recordWinner } from "@/lib/bracket/progress";
import { pairSwissRound, suggestedSwissRounds } from "@/lib/bracket/swiss";
import { BracketError, type BracketMatch } from "@/lib/bracket/types";
import { activeBattles, matchForOrganizer, voidBattlesOfMatches } from "@/lib/battles";
import { db } from "@/lib/db";
import { matches, tournaments } from "@/lib/db/schema";
import { rulesFor } from "@/lib/rules";
import { scoreMatch, scoreText } from "@/lib/scoring/engine";
import { reconcileQueue } from "@/lib/venue";
import { swissRoundDue } from "./build";
import { isFinished, isSwiss, stagePhase, stageType } from "./format";
import { roundLabeller } from "./labels";
import { insertStage, stagePlayers, stageRows } from "./queries";
import { changes, groupPrefix, prefixKeys, toBracket } from "./store";

export type SubmitOutcome =
  | { status: "synced"; warning?: string }
  | { status: "needs_confirmation"; affected: string[] }
  | { status: "invalid" | "failed" | "conflict"; error: string };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Records the result the pad scored: the winner moves on through the bracket, and the loser too
 * in double elimination, all in one transaction. A changed winner is a correction: the later
 * matches the old result reached lose that player, and their results if they were played. Those
 * are listed for the organizer first, and only cleared with `confirmDestructive`. After the last
 * result of a Swiss round, the next round is paired.
 */
export async function submitResult(
  organizerId: string,
  matchId: string,
  options: { confirmDestructive?: boolean } = {},
): Promise<SubmitOutcome> {
  try {
    return await db.transaction((tx) => record(tx, organizerId, matchId, options));
  } catch (error) {
    if (error instanceof BracketError) return { status: "invalid", error: error.message };
    throw error;
  }
}

async function record(tx: Tx, organizerId: string, matchId: string, options: { confirmDestructive?: boolean }): Promise<SubmitOutcome> {
  const found = await matchForOrganizer(organizerId, matchId, tx);
  if (!found) return { status: "invalid", error: "Match not found." };
  // One bracket change at a time per tournament; the match is read again under the lock.
  const [tournament] = await tx.select().from(tournaments).where(eq(tournaments.id, found.tournament.id)).for("update");
  const [match] = await tx.select().from(matches).where(eq(matches.id, matchId));

  if (!match.player1Id || !match.player2Id) return { status: "invalid", error: "Both players must be known before reporting." };
  if (isFinished(tournament.state)) return { status: "invalid", error: "This tournament is finished, so its results can't be changed." };
  if (match.stage === "group" && stagePhase(tournament) !== "groups") {
    return { status: "invalid", error: "The group stage has ended, so its results can't be changed." };
  }

  const rules = await rulesFor(tournament, match, tx);
  const score = scoreMatch(rules, await activeBattles(matchId, tx));
  if (!score.winner) return { status: "invalid", error: "The match isn't decided yet." };
  const winnerId = score.winner === 1 ? match.player1Id : match.player2Id;

  const rows = await stageRows(tx, tournament.id, match.stage, match.groupNumber);
  const before = rows.map(toBracket);
  let after = before;
  let erased: string[] = [];
  if (!match.winnerId) after = recordWinner(before, match.key, winnerId);
  else if (match.winnerId !== winnerId) ({ matches: after, erased } = correctWinner(before, match.key, winnerId));

  if (erased.length && !options.confirmDestructive) {
    const labelOf = roundLabeller(tournament, rows);
    return {
      status: "needs_confirmation",
      affected: rows.filter((r) => erased.includes(r.key)).map((r) => `${labelOf(r)} · ${r.identifier}${r.scores ? ` (${r.scores})` : ""}`),
    };
  }

  const byKey = new Map(rows.map((r) => [r.key, r]));
  const changed = changes(before, after);
  for (const c of changed) {
    await tx
      .update(matches)
      .set({ player1Id: c.player1Id, player2Id: c.player2Id, winnerId: c.winnerId, state: c.state })
      .where(eq(matches.id, byKey.get(c.key)!.id));
  }
  // What was played in a match that lost its result or a player no longer counts.
  const wiped = rows.filter((r) => r.key !== match.key && (erased.includes(r.key) || changed.some((c) => c.key === r.key && c.lostPlayer)));
  if (wiped.length) {
    const ids = wiped.map((r) => r.id);
    await voidBattlesOfMatches(tx, ids, "reset_by_correction");
    await tx.update(matches).set({ ruleSnapshot: null, scores: null, reportedBy: null, reportedAt: null }).where(inArray(matches.id, ids));
  }
  await tx
    .update(matches)
    .set({ scores: scoreText(rules, score), reportedBy: organizerId, reportedAt: new Date() })
    .where(eq(matches.id, matchId));

  const warning = isSwiss(stageType(tournament, match.stage)) ? await pairNextRound(tx, tournament, match, after) : undefined;
  // Frees the stadium, calls the on-deck match and pulls newly ready matches into the queue.
  await reconcileQueue(tournament.id, tx);
  return warning ? { status: "synced", warning } : { status: "synced" };
}

/**
 * Pairs the next round of a Swiss stage (or group) once its latest round is played, and rounds
 * remain. A Swiss group plays the suggested number of rounds for its players; the final stage, or
 * a Swiss tournament, the number the tournament has. Returns a warning if no pairing was possible.
 */
async function pairNextRound(
  tx: Tx,
  tournament: typeof tournaments.$inferSelect,
  match: typeof matches.$inferSelect,
  played: BracketMatch[],
): Promise<string | undefined> {
  const everyone = await stagePlayers(tx, tournament, match.stage, match.groupNumber);
  const rounds = match.stage === "group" ? suggestedSwissRounds(everyone.length) : (tournament.swissRounds ?? suggestedSwissRounds(everyone.length));
  if (!swissRoundDue(played, rounds)) return undefined;
  const active = await stagePlayers(tx, tournament, match.stage, match.groupNumber, { activeOnly: true });
  try {
    const next = prefixKeys(pairSwissRound(active, played), groupPrefix(match.groupNumber));
    await insertStage(tx, tournament.id, match.stage, match.groupNumber, next);
    return undefined;
  } catch (error) {
    if (!(error instanceof BracketError)) throw error;
    return `Saved, but the next round couldn't be paired: ${error.message}`;
  }
}
