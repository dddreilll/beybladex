import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { apiJson, apiOrganizer } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { tournaments } from "@/lib/db/schema";

// Polled by the control room to learn that something changed. 304 while nothing has.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await apiOrganizer(request);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return apiJson({ error: "Not found" }, 404);

  const [row] = await db
    .select({ version: tournaments.boardVersion })
    .from(tournaments)
    .where(and(eq(tournaments.id, id), eq(tournaments.organizerId, auth.organizer.id)))
    .limit(1);
  if (!row) return apiJson({ error: "Not found" }, 404);

  const etag = `W/"v${row.version}"`;
  const headers = { ETag: etag, "Cache-Control": "no-store" };
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });
  return NextResponse.json({ version: row.version }, { headers });
}
