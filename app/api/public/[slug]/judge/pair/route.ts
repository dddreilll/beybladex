import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { sessionCookie } from "@/lib/access";
import { crossSite, isSecureRequest } from "@/lib/api-auth";
import { SLUG_PATTERN } from "@/lib/board";
import { judgeAccess, judgeCookie, requestJudgeAccess } from "@/lib/judges";

type Context = { params: Promise<{ slug: string }> };

const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** A waiting tablet asks whether the organizer has approved it yet. */
export async function GET(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  const access = await judgeAccess(slug, request.cookies.get(judgeCookie(slug))?.value);
  return json(access.status === "pending" ? { status: "pending", code: access.code, stadium: access.stadium, name: access.name } : { status: access.status });
}

/** A tablet asks to judge a stadium. It gets a pairing code to display and a cookie to be known by. */
export async function POST(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  const refused = crossSite(request);
  if (refused) return refused;

  const body = z.object({ stadiumId: z.uuid(), name: z.string().max(200).optional() }).safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: "Pick a stadium." }, 400);

  const result = await requestJudgeAccess(
    slug,
    request.cookies.get(judgeCookie(slug))?.value,
    body.data.stadiumId,
    request.headers.get("user-agent"),
    body.data.name,
  );
  if (result.status === "not_found") return json({ error: "That stadium isn't available any more. Pick another." }, 404);
  if (result.status === "busy") return json({ error: "Too many devices are waiting for approval. Ask the organizer to clear the list." }, 429);
  if (result.status === "approved") return json({ status: "approved" });

  const response = json({ status: "pending", code: result.code, stadium: result.stadium, name: result.name });
  if (result.token) response.cookies.set(judgeCookie(slug), result.token, sessionCookie(isSecureRequest(request)));
  return response;
}
