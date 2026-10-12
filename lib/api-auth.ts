import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { currentOrganizer, type Organizer } from "@/lib/auth";

const noStore = { "Cache-Control": "no-store" };

export const apiJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

/**
 * Endpoints that act on a cookie must not be callable from another site's page: browsers always
 * send Origin on such requests, and it has to be ours.
 */
export function crossSite(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {}
  return host === request.headers.get("host") ? null : apiJson({ error: "Cross-site request refused." }, 403);
}

/** Whether the browser reached us over HTTPS (behind a proxy, the forwarded header says so). */
export function isSecureRequest(request: NextRequest): boolean {
  return (request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol).startsWith("https");
}

/** The signed-in organizer for a JSON endpoint, or the response to return instead. */
export async function apiOrganizer(request: NextRequest): Promise<{ organizer: Organizer } | { response: NextResponse }> {
  const refused = crossSite(request);
  if (refused) return { response: refused };
  const organizer = await currentOrganizer();
  if (!organizer) return { response: apiJson({ error: "Signed out." }, 401) };
  return { organizer };
}
