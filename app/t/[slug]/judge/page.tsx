import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { JudgeHome } from "@/components/judge/judge-home";
import { JudgePairing } from "@/components/judge/judge-pairing";
import { deviceLabel, judgeName } from "@/lib/access-codes";
import { SLUG_PATTERN } from "@/lib/board";
import { judgeAccess, judgeCookie, judgeSignUpInfo, judgeSnapshot } from "@/lib/judges";

export const metadata: Metadata = { title: "Judge", robots: { index: false } };

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ disconnected?: string; left?: string; as?: string; stay?: string }> };

export default async function JudgePage({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) notFound();
  const query = await searchParams;

  // An approved tablet sees its stadium; any other picks a stadium and waits for the organizer.
  const access = await judgeAccess(slug, (await cookies()).get(judgeCookie(slug))?.value);
  const snapshot = access.status === "approved" ? await judgeSnapshot(access) : null;
  if (snapshot) return <JudgeHome slug={slug} initial={snapshot} stay={query.stay === "1"} />;

  const info = await judgeSignUpInfo(slug);
  if (!info) notFound();
  return (
    <JudgePairing
      slug={slug}
      tournament={info.tournament}
      stadiums={info.stadiums}
      // A judge who just left a stadium keeps the name they had there.
      defaultName={judgeName(typeof query.as === "string" ? query.as : null, deviceLabel((await headers()).get("user-agent")))}
      initial={access.status === "pending" ? { code: access.code, stadium: access.stadium, name: access.name } : null}
      disconnected={query.disconnected === "1"}
      // The stadium this device just left, to say so (plain text, shown as typed).
      left={typeof query.left === "string" && query.left ? query.left.slice(0, 40) : null}
    />
  );
}
