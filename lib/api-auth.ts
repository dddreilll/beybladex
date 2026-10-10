import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { currentOrganizer, type Organizer } from "@/lib/auth";

const noStore = { "Cache-Control": "no-store" };

export const apiJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

/**
 * The signed-in organizer for a JSON endpoint, or the response to return instead.
 * These endpoints change data using the session cookie, so a cross-site page must not be
 * able to call them: browsers always send Origin on such requests, and it has to be ours.
 */
export async function apiOrganizer(request: NextRequest): Promise<{ organizer: Organizer } | { response: NextResponse }> {
  const origin = request.headers.get("origin");
  if (origin) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== request.headers.get("host")) return { response: apiJson({ error: "Cross-site request refused." }, 403) };
  }
  const organizer = await currentOrganizer();
  if (!organizer) return { response: apiJson({ error: "Signed out." }, 401) };
  return { organizer };
}
