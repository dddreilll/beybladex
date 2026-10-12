import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { PlayerSignIn } from "@/components/board/player-sign-in";
import { PlayerView } from "@/components/board/player-view";
import { playerAccess, playerCookie } from "@/lib/access";
import { playerSheets } from "@/lib/battle-sheet";
import { playerSnapshot, signInInfo, SLUG_PATTERN } from "@/lib/board";
import { pushConfig } from "@/lib/push";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: { absolute: "BXQ Pass" },
    robots: { index: false },
    // Installable per tournament: iPhones only deliver web push to home-screen apps.
    manifest: SLUG_PATTERN.test(slug) ? `/t/${slug}/manifest.webmanifest` : undefined,
    appleWebApp: { capable: true, title: "BXQ Pass", statusBarStyle: "black-translucent" },
  };
}

export default async function PlayerPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) notFound();

  const access = await playerAccess(slug, (await cookies()).get(playerCookie(slug))?.value);
  const snapshot = access.status === "signed_in" ? await playerSnapshot(slug, access.playerId) : null;
  if (snapshot) {
    return (
      <div className="dark min-h-svh bg-background text-foreground">
        {/* Keyed by player: scanning someone else's slip on this phone starts their page afresh. */}
        <PlayerView
          key={snapshot.me.id}
          slug={slug}
          initial={snapshot}
          initialMatches={await playerSheets(slug, snapshot.me.id)}
          vapidPublicKey={pushConfig()?.publicKey ?? null}
        />
      </div>
    );
  }

  // Not signed in on this device: names only, and nothing about any match.
  const info = await signInInfo(slug);
  if (!info) notFound();
  return (
    <div className="dark min-h-svh bg-background text-foreground">
      <PlayerSignIn slug={slug} tournament={info.tournament} players={info.players} replaced={access.status === "replaced"} />
    </div>
  );
}
