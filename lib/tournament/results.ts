import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { correctWinner, recordWinner } from "@/lib/bracket/progress";
import { pairSwissRound, suggestedSwissRounds } from "@/lib/bracket/swiss";
import { BracketError, type BracketMatch } from "@/lib/bracket/types";
import { activeBattles, matchForOrganizer, voidBattlesOfMatches } from "@/lib/battles";
import { db } from "@/lib/db";
import { matches, participants, tournaments } from "@/lib/db/schema";
import { rulesFor } from "@/lib/rules";
import { scoreMatch, scoreText } from "@/lib/scoring/engine";
import { reconcileQueue } from "@/lib/venue";
import { swissRoundDue } from "./build";
import { isFinished, isSwiss, stagePhase, stageType, type Stage } from "./format";
import { matchTitle, roundLabeller } from "./labels";
import { insertStage, stagePlayers, stageRows } from "./queries";
import { changes, groupPrefix, prefixKeys, toBracket } from "./store";

export type SubmitOutcome =
  | { status: "synced"; warning?: string }
  | { status: "needs_confirmation"; affected: string[] }
  | { status: "invalid" | "failed" | "conflict"; error: string };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = typeof matches.$inferSelect;

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
      affected: rows.filter((r) => erased.includes(r.key)).map((r) => `${labelOf(r)} · ${matchTitle(r.number)}${r.scores ? ` (${r.scores})` : ""}`),
    };
  }

  await writeBracket(tx, rows, after, erased, match.key);
  await tx
    .update(matches)
    .set({ scores: scoreText(rules, score), forfeit: false, reportedBy: organizerId, reportedAt: new Date() })
    .where(eq(matches.id, matchId));

  const warning = await settleStage(tx, tournament, match.stage, match.groupNumber, organizerId);
  // Frees the stadium, calls the on-deck match and pulls newly ready matches into the queue.
  await reconcileQueue(tournament.id, tx);
  return warning ? { status: "synced", warning } : { status: "synced" };
}

/**
 * Writes what the engine changed in a stage's matches. Whatever was played in a match that lost
 * its result or one of its players no longer counts: its battles are voided and its score cleared.
 * `except` is the match whose result is being recorded, which keeps its battles.
 */
async function writeBracket(tx: Tx, rows: Row[], after: BracketMatch[], erased: string[], except: string) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const changed = changes(rows.map(toBracket), after);
  for (const c of changed) {
    await tx
      .update(matches)
      .set({ player1Id: c.player1Id, player2Id: c.player2Id, winnerId: c.winnerId, state: c.state })
      .where(eq(matches.id, byKey.get(c.key)!.id));
  }
  const wiped = rows.filter((r) => r.key !== except && (erased.includes(r.key) || changed.some((c) => c.key === r.key && c.lostPlayer)));
  if (wiped.length) {
    const ids = wiped.map((r) => r.id);
    await voidBattlesOfMatches(tx, ids, "reset_by_correction");
    await tx.update(matches).set({ ruleSnapshot: null, scores: null, forfeit: false, reportedBy: null, reportedAt: null }).where(inArray(matches.id, ids));
  }
}

/**
 * Brings a stage (or a group) up to date after its bracket changed. An open match with a player
 * who dropped out goes to the other player as a forfeit, which can open the next one, so this
 * repeats until none is left; if both dropped out, player 1 goes on. Then a Swiss gets its next
 * round if one is due. Returns a warning if that round couldn't be paired.
 */
export async function settleStage(
  tx: Tx,
  tournament: typeof tournaments.$inferSelect,
  stage: Stage,
  groupNumber: number | null,
  organizerId: string,
): Promise<string | undefined> {
  const dropped = new Set(
    (
      await tx
        .select({ id: participants.id })
        .from(participants)
        .where(and(eq(participants.tournamentId, tournament.id), eq(participants.active, false)))
    ).map((p) => p.id),
  );
  for (;;) {
    const rows = await stageRows(tx, tournament.id, stage, groupNumber);
    const open = rows.find((r) => r.state === "open" && [r.player1Id, r.player2Id].some((p) => p && dropped.has(p)));
    if (!open) {
      if (!isSwiss(stageType(tournament, stage))) return undefined;
      return pairNextRound(tx, tournament, stage, groupNumber, rows.map(toBracket));
    }
    const winner = dropped.has(open.player1Id!) && !dropped.has(open.player2Id!) ? open.player2Id! : open.player1Id!;
    await writeBracket(tx, rows, recordWinner(rows.map(toBracket), open.key, winner), [], open.key);
    await voidBattlesOfMatches(tx, [open.id], "forfeit");
    await tx
      .update(matches)
      .set({ forfeit: true, scores: null, ruleSnapshot: null, reportedBy: organizerId, reportedAt: new Date() })
      .where(eq(matches.id, open.id));
  }
}

/**
 * Pairs the next round of a Swiss stage (or group) once its latest round is played, and rounds
 * remain. A Swiss group plays the suggested number of rounds for its players; the final stage, or
 * a Swiss tournament, the number the tournament has. Returns a warning if no pairing was possible.
 */
async function pairNextRound(
  tx: Tx,
  tournament: typeof tournaments.$inferSelect,
  stage: Stage,
  groupNumber: number | null,
  played: BracketMatch[],
): Promise<string | undefined> {
  const everyone = await stagePlayers(tx, tournament, stage, groupNumber);
  const rounds = stage === "group" ? suggestedSwissRounds(everyone.length) : (tournament.swissRounds ?? suggestedSwissRounds(everyone.length));
  if (!swissRoundDue(played, rounds)) return undefined;
  const active = await stagePlayers(tx, tournament, stage, groupNumber, { activeOnly: true });
  try {
    const next = prefixKeys(pairSwissRound(active, played), groupPrefix(groupNumber));
    await insertStage(tx, tournament.id, stage, groupNumber, next);
    return undefined;
  } catch (error) {
    if (!(error instanceof BracketError)) throw error;
    return `Saved, but the next round couldn't be paired: ${error.message}`;
  }
}
