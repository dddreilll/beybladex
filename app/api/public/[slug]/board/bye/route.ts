import { NextResponse, type NextRequest } from "next/server";
import { boardCookie, closeBoardScreen } from "@/lib/access";
import { crossSite } from "@/lib/api-auth";
import { SLUG_PATTERN } from "@/lib/board";

// Sent by a call board screen as its tab closes (navigator.sendBeacon), so the control room shows
// it closed at once rather than after SCREEN_OPEN_MS. It answers the same whatever happened.
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const refused = crossSite(request);
  if (refused) return refused;
  const { slug } = await params;
  if (SLUG_PATTERN.test(slug)) await closeBoardScreen(slug, request.cookies.get(boardCookie(slug))?.value);
  return new NextResponse(null, { status: 204 });
}
