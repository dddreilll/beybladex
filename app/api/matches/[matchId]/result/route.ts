import { revalidatePath } from "next/cache";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { apiJson, crossSite } from "@/lib/api-auth";
import { matchForOrganizer } from "@/lib/battles";
import { submitResult } from "@/lib/challonge/report";
import { padActor } from "@/lib/pad";

const bodySchema = z.object({ confirmDestructive: z.boolean().default(false) });

/**
 * Sends the match's result to Challonge. Returns the outcome as JSON (also for refusals).
 * A judge tablet sends its stadium's match on the organizer's connection; correcting a result
 * that was already sent stays with the organizer.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ matchId: string }> }) {
  const refused = crossSite(request);
  if (refused) return refused;

  const matchId = z.uuid().safeParse((await params).matchId);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!matchId.success || !body.success) return apiJson({ error: "Invalid request." }, 400);

  const who = await padActor(request, matchId.data);
  if ("status" in who) return apiJson({ error: who.status === 401 ? "Signed out." : "Match not found." }, who.status);
  const { actor } = who;

  const found = await matchForOrganizer(actor.organizerId, matchId.data);
  if (!found) return apiJson({ error: "Match not found." }, 404);
  if (actor.kind === "judge" && found.match.state === "complete") {
    return apiJson({ status: "invalid", error: "This result is already on Challonge. Ask the organizer to correct it." });
  }

  const outcome = await submitResult(actor.organizerId, matchId.data, actor.kind === "judge" ? {} : body.data);
  revalidatePath(`/tournaments/${found.tournament.id}`);
  return apiJson(outcome);
}
