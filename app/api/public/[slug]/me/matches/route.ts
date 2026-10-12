import { NextResponse, type NextRequest } from "next/server";
import { playerAccess, playerCookie } from "@/lib/access";
import { playerSheets } from "@/lib/battle-sheet";
import { SLUG_PATTERN } from "@/lib/board";

const noStore = { "Cache-Control": "no-store" };

// A signed-in player's finished matches with their battle-by-battle scores. The phone asks again
// only when the player feed says one of their results changed.
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const access = await playerAccess(slug, request.cookies.get(playerCookie(slug))?.value);
  if (access.status !== "signed_in") return NextResponse.json({ error: "Signed out." }, { status: 401, headers: noStore });
  return NextResponse.json({ matches: await playerSheets(slug, access.playerId) }, { headers: noStore });
}
