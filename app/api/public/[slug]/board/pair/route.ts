import { NextResponse, type NextRequest } from "next/server";
import { boardAccess, boardCookie, requestBoardAccess, sessionCookie } from "@/lib/access";
import { crossSite, isSecureRequest } from "@/lib/api-auth";
import { SLUG_PATTERN } from "@/lib/board";

type Context = { params: Promise<{ slug: string }> };

const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** A waiting screen asks whether the organizer has approved it yet. */
export async function GET(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  const access = await boardAccess(slug, request.cookies.get(boardCookie(slug))?.value);
  return json(access.status === "pending" ? { status: "pending", code: access.code } : { status: access.status });
}

/** A screen asks to show the board. It gets a pairing code to display and a cookie to be known by. */
export async function POST(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  const refused = crossSite(request);
  if (refused) return refused;

  const result = await requestBoardAccess(slug, request.cookies.get(boardCookie(slug))?.value, request.headers.get("user-agent"));
  if (result.status === "not_found") return json({ error: "Not found" }, 404);
  if (result.status === "busy") return json({ error: "Too many screens are waiting for approval. Ask the organizer to clear the list." }, 429);
  if (result.status === "approved") return json({ status: "approved" });

  const response = json({ status: "pending", code: result.code });
  if (result.token) response.cookies.set(boardCookie(slug), result.token, sessionCookie(isSecureRequest(request)));
  return response;
}
