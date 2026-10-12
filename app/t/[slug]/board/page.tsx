import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { BoardPairing } from "@/components/board/board-pairing";
import { CallBoard } from "@/components/board/call-board";
import { boardAccess, boardCookie } from "@/lib/access";
import { boardSnapshot, signInInfo, SLUG_PATTERN } from "@/lib/board";
import { appUrl } from "@/lib/config";

export const metadata: Metadata = { title: "Call board", robots: { index: false } };

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ disconnected?: string }> };

export default async function CallBoardPage({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) notFound();

  // Only a screen the organizer approved gets the board; any other gets a pairing code to show.
  const access = await boardAccess(slug, (await cookies()).get(boardCookie(slug))?.value);
  if (access.status !== "approved") {
    const info = await signInInfo(slug);
    if (!info) notFound();
    return (
      <div className="dark">
        <BoardPairing
          slug={slug}
          tournament={info.tournament}
          initialCode={access.status === "pending" ? access.code : null}
          disconnected={(await searchParams).disconnected === "1"}
        />
      </div>
    );
  }

  const snapshot = await boardSnapshot(slug);
  if (!snapshot) notFound();

  const playerUrl = `${appUrl()}/t/${slug}`;
  // Output of the qrcode library from a URL we built: safe to inline.
  const qrSvg = await QRCode.toString(playerUrl, { type: "svg", margin: 0, errorCorrectionLevel: "M" });

  return (
    <div className="dark">
      <CallBoard slug={slug} initial={snapshot} qrSvg={qrSvg} playerUrl={playerUrl} />
    </div>
  );
}
