import { eq } from "drizzle-orm";
import { SLUG_PATTERN } from "@/lib/board";
import { db } from "@/lib/db";
import { tournaments } from "@/lib/db/schema";

// One manifest per tournament so "Add to Home Screen" (required for push on iPhone) opens
// this tournament's player page rather than the organizer app.
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return new Response("Not found", { status: 404 });
  const [tournament] = await db.select({ name: tournaments.name }).from(tournaments).where(eq(tournaments.publicSlug, slug)).limit(1);
  if (!tournament) return new Response("Not found", { status: 404 });

  return Response.json(
    {
      name: `${tournament.name} · My match`,
      short_name: "My match",
      start_url: `/t/${slug}`,
      scope: "/",
      display: "standalone",
      background_color: "#0B0E13",
      theme_color: "#0B0E13",
      icons: [
        { src: "/icons/192", sizes: "192x192", type: "image/png" },
        { src: "/icons/512", sizes: "512x512", type: "image/png" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" } },
  );
}
