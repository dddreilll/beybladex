import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { crossSite } from "@/lib/api-auth";
import { SLUG_PATTERN } from "@/lib/board";
import { judgeAccess, judgeCookie, judgeSnapshot, leaveStadium, renameJudgeTablet } from "@/lib/judges";

const noStore = { "Cache-Control": "no-store" };

// Polled by an approved judge tablet between matches: what is at its own stadium. An unchanged
// board is a 304, which also counts as the tablet checking in.
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const access = await judgeAccess(slug, request.cookies.get(judgeCookie(slug))?.value);
  if (access.status !== "approved") return NextResponse.json({ error: "This device isn't approved." }, { status: 401, headers: noStore });

  const etag = `W/"v${access.version}"`;
  const headers = { ...noStore, ETag: etag };
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });

  const snapshot = await judgeSnapshot(access);
  if (!snapshot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(snapshot, { headers: { ...headers, ETag: `W/"v${snapshot.version}"` } });
}

/** A judge renames themselves. A blank name goes back to the detected device name. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refused = crossSite(request);
  if (refused) return refused;

  const body = z.object({ name: z.string().max(200) }).safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Enter a name." }, { status: 400, headers: noStore });
  const name = await renameJudgeTablet(slug, request.cookies.get(judgeCookie(slug))?.value, body.data.name);
  if (!name) return NextResponse.json({ error: "This device isn't signed up as a judge." }, { status: 401, headers: noStore });
  return NextResponse.json({ name }, { headers: noStore });
}

/** A judge leaves their stadium. The match there, and its score, stay as they are. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refused = crossSite(request);
  if (refused) return refused;

  const left = await leaveStadium(slug, request.cookies.get(judgeCookie(slug))?.value);
  if (!left) return NextResponse.json({ error: "This device isn't signed up as a judge." }, { status: 401, headers: noStore });
  const response = NextResponse.json({ ok: true, stadium: left.stadium }, { headers: noStore });
  response.cookies.delete(judgeCookie(slug));
  return response;
}
