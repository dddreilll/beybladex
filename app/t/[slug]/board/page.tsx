import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { CallBoard } from "@/components/board/call-board";
import { boardSnapshot, SLUG_PATTERN } from "@/lib/board";
import { appUrl } from "@/lib/config";

export const metadata: Metadata = { title: "Call board", robots: { index: false } };

export default async function CallBoardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) notFound();
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
