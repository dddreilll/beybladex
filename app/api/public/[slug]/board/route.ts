import { NextResponse, type NextRequest } from "next/server";
import { boardSnapshot, boardVersion, SLUG_PATTERN } from "@/lib/board";

// Polled every few seconds by call boards, player pages and control rooms. The version ETag
// makes the common "nothing changed" case a single indexed lookup returning 304.
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const version = await boardVersion(slug);
  if (version === null) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const etag = `W/"v${version}"`;
  const headers = { ETag: etag, "Cache-Control": "no-store" };
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });

  const snapshot = await boardSnapshot(slug);
  if (!snapshot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(snapshot, { headers: { ...headers, ETag: `W/"v${snapshot.version}"` } });
}
