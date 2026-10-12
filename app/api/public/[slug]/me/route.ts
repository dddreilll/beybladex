import { NextResponse, type NextRequest } from "next/server";
import { playerAccess, playerCookie } from "@/lib/access";
import { playerSnapshot, SLUG_PATTERN } from "@/lib/board";

const noStore = { "Cache-Control": "no-store" };

// Polled by a signed-in player's phone: their own match only. An unchanged board is a 304.
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const access = await playerAccess(slug, request.cookies.get(playerCookie(slug))?.value);
  if (access.status !== "signed_in") {
    // "replaced" lets the phone explain that the player signed in somewhere else.
    return NextResponse.json({ error: "Signed out.", reason: access.status }, { status: 401, headers: noStore });
  }

  const etag = `W/"v${access.version}"`;
  const headers = { ...noStore, ETag: etag };
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });

  const snapshot = await playerSnapshot(slug, access.playerId);
  // The player was removed from the bracket on Challonge.
  if (!snapshot) return NextResponse.json({ error: "Signed out.", reason: "none" }, { status: 401, headers: noStore });
  return NextResponse.json(snapshot, { headers: { ...headers, ETag: `W/"v${snapshot.version}"` } });
}
