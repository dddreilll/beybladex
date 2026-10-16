import { NextResponse, type NextRequest } from "next/server";
import { closePlayerSession, playerCookie } from "@/lib/access";
import { crossSite } from "@/lib/api-auth";
import { SLUG_PATTERN } from "@/lib/board";

// Sent by a player's Pass as its tab closes (navigator.sendBeacon), so the control room shows it
// closed at once. The player stays signed in. It answers the same whatever happened.
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const refused = crossSite(request);
  if (refused) return refused;
  const { slug } = await params;
  if (SLUG_PATTERN.test(slug)) await closePlayerSession(slug, request.cookies.get(playerCookie(slug))?.value);
  return new NextResponse(null, { status: 204 });
}
