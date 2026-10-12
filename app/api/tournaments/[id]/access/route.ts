import type { NextRequest } from "next/server";
import { accessOverview } from "@/lib/access";
import { apiJson, apiOrganizer } from "@/lib/api-auth";
import { ownedTournament } from "@/lib/venue";

// Polled by the control room: which call boards are open and which players are signed in.
// A screen checking in doesn't change the board, so this can't ride on the board version.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await apiOrganizer(request);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return apiJson({ error: "Not found" }, 404);

  const tournament = await ownedTournament(auth.organizer.id, id);
  if (!tournament) return apiJson({ error: "Not found" }, 404);
  return apiJson(await accessOverview(tournament.id, tournament.boardLimit));
}
