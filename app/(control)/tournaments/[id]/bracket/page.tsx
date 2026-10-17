import { redirect } from "next/navigation";

/** The bracket lives in the Desk's Bracket tab now; older links still land there. */
export default async function BracketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/tournaments/${id}?tab=bracket`);
}
