import { type NextRequest } from "next/server";
import { z } from "zod";
import { apiJson, apiOrganizer } from "@/lib/api-auth";
import { applyBattleOps, battleOpsSchema } from "@/lib/battles";

const bodySchema = z.object({ ops: battleOpsSchema });

/** Judge-pad taps. Idempotent by op id, so the offline outbox can resend freely. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ matchId: string }> }) {
  const auth = await apiOrganizer(request);
  if ("response" in auth) return auth.response;

  const matchId = z.uuid().safeParse((await params).matchId);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!matchId.success || !body.success) return apiJson({ error: "Invalid request." }, 400);

  const result = await applyBattleOps(auth.organizer.id, matchId.data, body.data.ops);
  if (!result) return apiJson({ error: "Match not found." }, 404);
  return apiJson({ battles: result.battles, rejected: result.rejected, serverTime: Date.now() });
}
