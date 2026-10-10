import { revalidatePath } from "next/cache";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { apiJson, apiOrganizer } from "@/lib/api-auth";
import { matchForOrganizer } from "@/lib/battles";
import { submitResult } from "@/lib/challonge/report";

const bodySchema = z.object({ confirmDestructive: z.boolean().default(false) });

/** Sends the match's result to Challonge. Returns the outcome as JSON (also for refusals). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ matchId: string }> }) {
  const auth = await apiOrganizer(request);
  if ("response" in auth) return auth.response;

  const matchId = z.uuid().safeParse((await params).matchId);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!matchId.success || !body.success) return apiJson({ error: "Invalid request." }, 400);

  const found = await matchForOrganizer(auth.organizer.id, matchId.data);
  if (!found) return apiJson({ error: "Match not found." }, 404);

  const outcome = await submitResult(auth.organizer.id, matchId.data, body.data);
  revalidatePath(`/tournaments/${found.tournament.id}`);
  return apiJson(outcome);
}
