import { NextResponse, type NextRequest } from "next/server";
import { boardAccess, boardCookie } from "@/lib/access";
import { boardSnapshot, SLUG_PATTERN } from "@/lib/board";

const noStore = { "Cache-Control": "no-store" };

// Polled by call board screens the organizer approved. The version ETag makes the common
// "nothing changed" case a single lookup returning 304, which also counts as the screen checking in.
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const access = await boardAccess(slug, request.cookies.get(boardCookie(slug))?.value);
  // Unknown tournaments answer the same way, so the address alone reveals nothing.
  if (access.status !== "approved") return NextResponse.json({ error: "This screen isn't approved." }, { status: 401, headers: noStore });

  const etag = `W/"v${access.version}"`;
  const headers = { ...noStore, ETag: etag };
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });

  const snapshot = await boardSnapshot(slug);
  if (!snapshot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(snapshot, { headers: { ...headers, ETag: `W/"v${snapshot.version}"` } });
}
