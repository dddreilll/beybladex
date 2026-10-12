import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { battles, matches, tournaments, type Match } from "@/lib/db/schema";
import { rulesFor } from "@/lib/rules";
import { bumpBoard, markUnderway, NO_JUDGE, setPlaying, stadiumHasJudge } from "@/lib/venue";
import { scoreMatch, ScoringError, type Battle } from "@/lib/scoring/engine";
import type { MatchRules } from "@/lib/scoring/profile";

const battleKind = z.enum(["spin", "over", "burst", "xtreme", "own", "launch_error", "draw"]);

export const battleOpsSchema = z
  .array(
    z.discriminatedUnion("op", [
      z.object({ op: z.literal("add"), opId: z.uuid(), kind: battleKind, side: z.union([z.literal(1), z.literal(2)]).nullable() }),
      z.object({ op: z.literal("void"), opId: z.uuid(), targetOpId: z.uuid() }),
      // "Start match" on the pad. An operation like the taps, so it works offline and in order.
      z.object({ op: z.literal("start"), opId: z.uuid() }),
    ]),
  )
  .max(100);

export type BattleOp = z.infer<typeof battleOpsSchema>[number];
export type PadBattle = Battle & { opId: string };

export async function matchForOrganizer(organizerId: string, matchId: string, executor: Pick<typeof db, "select"> = db) {
  const [row] = await executor
    .select({ match: matches, tournament: tournaments })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(and(eq(matches.id, matchId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  return row ?? null;
}

export async function activeBattles(matchId: string, executor: Pick<typeof db, "select"> = db): Promise<PadBattle[]> {
  const rows = await executor
    .select({ opId: battles.opId, kind: battles.kind, side: battles.side })
    .from(battles)
    .where(and(eq(battles.matchId, matchId), isNull(battles.voidedAt)))
    .orderBy(asc(battles.seq));
  return rows.map((r) => ({ opId: r.opId, kind: r.kind, side: r.side ?? null }));
}

export type ApplyResult = {
  battles: PadBattle[];
  rules: MatchRules;
  rejected: { opId: string; reason: string }[];
};

/**
 * Applies judge-pad operations in order. Safe to retry: an add whose op_id already exists is skipped,
 * voiding an already-voided battle does nothing, and starting a started match does nothing. The
 * match row is locked so two devices scoring the same match are serialised.
 *
 * A match that was called to a stadium has to be started before it can be scored, and can only
 * be started while that stadium has a judge. `judgeStadiumId` is set when a judge tablet (not the
 * organizer) is asking: it may only touch the match currently at its own stadium.
 */
export async function applyBattleOps(
  organizerId: string,
  matchId: string,
  ops: BattleOp[],
  options: { judgeStadiumId?: string } = {},
): Promise<ApplyResult | null> {
  const outcome = await db.transaction(async (tx) => {
    const found = await matchForOrganizer(organizerId, matchId, tx);
    if (!found) return null;
    await tx.select({ id: matches.id }).from(matches).where(eq(matches.id, matchId)).for("update");

    const { match, tournament } = found;
    if (options.judgeStadiumId && (match.stadiumId !== options.judgeStadiumId || (match.callStatus !== "called" && match.callStatus !== "playing"))) {
      return null;
    }
    let status = match.callStatus;
    let started = false;
    const rules = await rulesFor(tournament, match, tx);
    let current = await activeBattles(matchId, tx);
    const rejected: ApplyResult["rejected"] = [];

    const addOps = ops.filter((o) => o.op === "add").map((o) => o.opId);
    const existing = new Set(
      addOps.length
        ? (await tx.select({ opId: battles.opId }).from(battles).where(inArray(battles.opId, addOps))).map((r) => r.opId)
        : [],
    );

    for (const op of ops) {
      if (op.op === "start") {
        if (status === "playing") continue;
        if (status !== "called") rejected.push({ opId: op.opId, reason: "This match hasn't been called to a stadium yet." });
        else if (!(await stadiumHasJudge(tx, match.stadiumId))) rejected.push({ opId: op.opId, reason: NO_JUDGE });
        else {
          status = "playing";
          started = true;
        }
        continue;
      }
      if (op.op === "void") {
        await tx
          .update(battles)
          .set({ voidedAt: new Date(), voidReason: "undo" })
          .where(and(eq(battles.matchId, matchId), eq(battles.opId, op.targetOpId), isNull(battles.voidedAt)));
        current = current.filter((b) => b.opId !== op.targetOpId);
        continue;
      }
      if (existing.has(op.opId)) continue;
      if (status === "called") {
        rejected.push({ opId: op.opId, reason: "Start the match before scoring." });
        continue;
      }
      const reason = validateAdd(match, rules, current, op);
      if (reason) {
        rejected.push({ opId: op.opId, reason });
        continue;
      }
      const side = op.kind === "draw" ? null : op.side;
      await tx.insert(battles).values({ matchId, opId: op.opId, kind: op.kind, side, createdBy: organizerId });
      existing.add(op.opId);
      current = [...current, { opId: op.opId, kind: op.kind, side }];
    }

    if (!match.ruleSnapshot && current.length > 0) {
      await tx.update(matches).set({ ruleSnapshot: rules }).where(eq(matches.id, matchId));
    }
    // Either way the board changed: a match started, or its live score moved.
    if (started) await setPlaying(matchId, tournament.id, tx);
    else if (ops.length) await bumpBoard(tx, tournament.id);
    return { result: { battles: current, rules, rejected }, startedHere: started ? { match, tournament } : null };
  });
  if (!outcome) return null;
  // After the transaction: this can be a Challonge request, and the match has started regardless.
  if (outcome.startedHere) {
    const warning = await markUnderway(organizerId, outcome.startedHere.tournament, outcome.startedHere.match);
    if (warning) console.warn(warning);
  }
  return outcome.result;
}

function validateAdd(match: Match, rules: MatchRules, current: PadBattle[], op: Extract<BattleOp, { op: "add" }>): string | null {
  if (!match.player1ChallongeId || !match.player2ChallongeId) return "Both players must be known before scoring.";
  if (op.kind !== "draw" && op.side === null) return "Pick a player for that battle.";
  try {
    scoreMatch(rules, [...current, { kind: op.kind, side: op.kind === "draw" ? null : op.side }]);
    return null;
  } catch (error) {
    if (error instanceof ScoringError) return error.message;
    throw error;
  }
}

/** Voids every battle of matches whose result Challonge wiped (a correction upstream; spike S4b). */
export async function voidBattlesOfMatches(tx: Pick<typeof db, "update">, matchIds: string[], reason: string) {
  if (!matchIds.length) return;
  await tx
    .update(battles)
    .set({ voidedAt: new Date(), voidReason: reason })
    .where(and(inArray(battles.matchId, matchIds), isNull(battles.voidedAt)));
}

