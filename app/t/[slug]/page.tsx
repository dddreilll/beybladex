import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlayerView } from "@/components/board/player-view";
import { boardSnapshot, SLUG_PATTERN } from "@/lib/board";
import { pushConfig } from "@/lib/push";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: "My match",
    robots: { index: false },
    // Installable per tournament: iPhones only deliver web push to home-screen apps.
    manifest: SLUG_PATTERN.test(slug) ? `/t/${slug}/manifest.webmanifest` : undefined,
    appleWebApp: { capable: true, title: "My match", statusBarStyle: "black-translucent" },
  };
}

export default async function PlayerPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) notFound();
  const snapshot = await boardSnapshot(slug);
  if (!snapshot) notFound();
  return (
    <div className="dark min-h-svh bg-background text-foreground">
      <PlayerView slug={slug} initial={snapshot} vapidPublicKey={pushConfig()?.publicKey ?? null} />
    </div>
  );
}
