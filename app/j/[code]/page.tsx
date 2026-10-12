import { notFound, redirect } from "next/navigation";
import { slugForShortCode } from "@/lib/short-links";

export const metadata = { title: { absolute: "BXQ Pad" }, robots: { index: false } };

// The short link for a judge's tablet. It leads to the sign-up screen, which needs approval.
export default async function JudgeShortLink({ params }: { params: Promise<{ code: string }> }) {
  const slug = await slugForShortCode((await params).code);
  if (!slug) notFound();
  redirect(`/t/${slug}/judge`);
}
