import { type NextRequest } from "next/server";
import { z } from "zod";
import { apiJson, crossSite } from "@/lib/api-auth";
import { applyBattleOps, battleOpsSchema } from "@/lib/battles";
import { padActor } from "@/lib/pad";

const bodySchema = z.object({ ops: battleOpsSchema });

/**
 * Judge-pad taps (and "Start match"), from the organizer or from the judge tablet of the match's
 * stadium. Idempotent by op id, so the offline outbox can resend freely.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ matchId: string }> }) {
  const refused = crossSite(request);
  if (refused) return refused;

  const matchId = z.uuid().safeParse((await params).matchId);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!matchId.success || !body.success) return apiJson({ error: "Invalid request." }, 400);

  const who = await padActor(request, matchId.data);
  if ("status" in who) return apiJson({ error: who.status === 401 ? "Signed out." : "Match not found." }, who.status);

  const result = await applyBattleOps(who.actor.organizerId, matchId.data, body.data.ops, {
    judgeStadiumId: who.actor.kind === "judge" ? who.actor.stadiumId : undefined,
  });
  if (!result) return apiJson({ error: "Match not found." }, 404);
  return apiJson({ battles: result.battles, rejected: result.rejected, serverTime: Date.now() });
}
