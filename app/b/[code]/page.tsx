import { notFound, redirect } from "next/navigation";
import { slugForShortCode } from "@/lib/short-links";

export const metadata = { title: { absolute: "BXQ Board" }, robots: { index: false } };

// The short link for a TV. The board it leads to still shows a pairing code until it is approved.
export default async function BoardShortLink({ params }: { params: Promise<{ code: string }> }) {
  const slug = await slugForShortCode((await params).code);
  if (!slug) notFound();
  redirect(`/t/${slug}/board`);
}
