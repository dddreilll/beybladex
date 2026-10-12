import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { TriangleAlert } from "lucide-react";
import { WarmPads } from "@/components/offline/outbox-sync";
import { PageHeader } from "@/components/page-shell";
import { accessOverview } from "@/lib/access";
import { requireOrganizer } from "@/lib/auth";
import { liveMatchInfo } from "@/lib/board";
import { callLabel } from "@/lib/call-label";
import { isFinalState } from "@/lib/challonge/map";
import { buildControlRoom, type QueueMatch } from "@/lib/control-room";
import { db } from "@/lib/db";
import { matches, participants, ruleProfiles, syncOutbox, tournaments } from "@/lib/db/schema";
import { finalizeBlockers } from "@/lib/finalize-check";
import { formatRelative, serverTime } from "@/lib/format";
import { tournamentProfile } from "@/lib/rules";
import { PRESETS } from "@/lib/scoring/profile";
import { boardShortLink, judgeShortLink } from "@/lib/short-links";
import { listStadiums, RECALL_COOLDOWN_MS } from "@/lib/venue";
import { AccessProvider, BoardsPanel, JudgesPanel, PlayersPanel } from "./access-panels";
import { AddStadiumButton, AddStadiumTile } from "./add-stadium";
import { FinalizeButton } from "./finalize-button";
import { LiveRefresh } from "./live-refresh";
import { QueueTable, type QueueRow } from "./queue-table";
import { ResyncButton } from "./resync-button";
import { RetryButton } from "./retry-button";
import { RuleCard } from "./rules-picker";
import { StadiumCard, type CardMatch, type CurrentMatch } from "./stadium-card";
import { VenueSettings } from "./venue-settings";
import { ViewBattles } from "./view-battles";
import { WaitingPanel } from "./waiting-panel";

export const metadata: Metadata = { title: { absolute: "BXQ Desk" } };

export default async function ControlRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const organizer = await requireOrganizer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.id, id), eq(tournaments.organizerId, organizer.id)))
    .limit(1);
  if (!tournament) notFound();

  const [participantRows, matchRows, ownProfiles, outbox, profile, stadiumRows, access] = await Promise.all([
    db.select().from(participants).where(eq(participants.tournamentId, id)),
    db.select().from(matches).where(eq(matches.tournamentId, id)),
    db
      .select({ id: ruleProfiles.id, name: ruleProfiles.name })
      .from(ruleProfiles)
      .where(eq(ruleProfiles.organizerId, organizer.id))
      .orderBy(asc(ruleProfiles.name)),
    db.select().from(syncOutbox).where(eq(syncOutbox.tournamentId, id)).orderBy(desc(syncOutbox.createdAt)),
    tournamentProfile(tournament),
    listStadiums(tournament.id),
    accessOverview(tournament.id, tournament.boardLimit),
  ]);
  const live = await liveMatchInfo(matchRows, new Map(participantRows.map((p) => [p.challongeId, p.name])));
  const room = buildControlRoom(tournament.tournamentType, participantRows, matchRows);
  const padHref = (matchId: string) => `/tournaments/${tournament.id}/matches/${matchId}`;
  const everyMatch = new Map([...room.ready, ...room.waiting, ...room.completed].map((m) => [m.id, m]));

  // Latest send per match: failures need the organizer, pending ones are on their way.
  const latestByMatch = new Map<string, (typeof outbox)[number]>();
  for (const row of outbox) if (!latestByMatch.has(row.matchId)) latestByMatch.set(row.matchId, row);
  const latest = [...latestByMatch.values()];
  const problems = latest.filter((r) => r.status === "failed" || r.status === "conflict");
  const sending = latest
    .filter((r) => r.status === "pending")
    .map((r) => {
      const m = everyMatch.get(r.matchId);
      return { id: r.id, label: m ? `${m.label} · ${m.player1} vs ${m.player2}` : "Match" };
    });

  const finalized = isFinalState(tournament.state);
  const blockers = finalized ? [] : finalizeBlockers({ matches: matchRows, unsent: problems.length + sending.length });
  const playerRows = participantRows
    .filter((p) => p.active)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ id: p.challongeId, name: p.name, passcode: p.passcode }));

  const renderedAt = serverTime();
  const toCard = (m: QueueMatch): CardMatch => ({
    id: m.id,
    label: m.label,
    roundLabel: m.roundLabel,
    players: `${m.player1} vs ${m.player2}`,
    padHref: padHref(m.id),
  });
  const atStadium = room.ready.filter((m) => m.callStatus !== "none");
  const cards = stadiumRows
    .filter((s) => s.active)
    .map((s) => {
      const here = atStadium.filter((m) => m.stadiumId === s.id);
      const current = here.find((m) => m.callStatus === "called" || m.callStatus === "playing");
      const onDeck = here.find((m) => m.callStatus === "on_deck");
      const now: CurrentMatch | null = current
        ? {
            ...toCard(current),
            status: current.callStatus === "playing" ? "playing" : "called",
            repeatLabel: callLabel(current.callCount),
            calledAgo: current.calledAt ? formatRelative(current.calledAt) : null,
            calledAt: current.calledAt?.toISOString() ?? null,
            recallReadyInMs:
              current.callStatus === "called" && current.calledAt
                ? Math.max(0, RECALL_COOLDOWN_MS - (renderedAt - current.calledAt.getTime()))
                : 0,
            liveScore: live.get(current.id)?.score ?? null,
            lastBattle: live.get(current.id)?.lastBattle ?? null,
            battles: live.get(current.id)?.battles ?? 0,
          }
        : null;
      return { stadium: { id: s.id, name: s.name }, now, next: onDeck ? toCard(onDeck) : null, hasOnDeck: Boolean(onDeck) };
    });

  const row = (m: QueueMatch, status: QueueRow["status"]): QueueRow => ({
    id: m.id,
    label: m.label,
    round: m.roundLabel,
    players: `${m.player1} vs ${m.player2}`,
    status,
    padHref: padHref(m.id),
  });
  const waitingForStadium = room.ready.filter((m) => m.callStatus === "none");
  const queueRows: QueueRow[] = [
    ...waitingForStadium.filter((m) => !m.held).map((m) => row(m, "ready")),
    ...waitingForStadium.filter((m) => m.held).map((m) => row(m, "held")),
    ...room.waiting.map((m) => row(m, "pending")),
  ];

  const length = `First to ${profile.targetPoints}${profile.bestOfSets > 1 ? `, best of ${profile.bestOfSets} sets` : ""}`;
  const ruleDetails = [
    // Most profile names already say this ("First to 4"); don't repeat it.
    ...(profile.name.toLowerCase().includes(`first to ${profile.targetPoints}`) && profile.bestOfSets === 1 ? [] : [length]),
    ...(profile.finals ? [`Finals override: first to ${profile.finals.targetPoints}, best of ${profile.finals.bestOfSets} sets`] : []),
    ...(profile.launchErrorPenalty
      ? [`${profile.launchErrorPenalty.strikes} launch errors give the opponent ${profile.launchErrorPenalty.points}`]
      : []),
  ];

  return (
    <AccessProvider tournamentId={tournament.id} initial={access}>
      <div className="flex min-h-svh flex-col">
        <LiveRefresh tournamentId={tournament.id} slug={tournament.publicSlug} version={tournament.boardVersion} />
        {/* Pre-load the pads for matches at stadiums so judges can open them even if the Wi-Fi drops. */}
        <WarmPads urls={atStadium.map((m) => padHref(m.id))} />

        <PageHeader title="BXQ Desk" subtitle={tournament.name}>
          <span className="rounded-full bg-success-muted px-3 py-2 text-sm font-semibold text-success">
            Synced {tournament.lastSyncedAt ? formatRelative(tournament.lastSyncedAt) : "never"}
          </span>
          <ResyncButton tournamentId={tournament.id} />
          <FinalizeButton
            tournamentId={tournament.id}
            tournamentName={tournament.name}
            finalized={finalized}
            hasStandings={participantRows.some((p) => p.finalRank != null)}
            blockers={blockers}
          />
        </PageHeader>

        <div className="flex flex-1 flex-wrap items-start gap-6 px-4 py-6 sm:px-6">
          <main className="flex min-w-0 flex-[999_1_36rem] flex-col gap-8">
            <section aria-labelledby="stadiums-heading" className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="stadiums-heading" className="font-display text-2xl font-semibold">
                  Stadiums
                </h2>
                <div className="flex flex-wrap items-center gap-4">
                  <VenueSettings
                    tournamentId={tournament.id}
                    autoOnDeck={tournament.autoOnDeck}
                    autoCall={tournament.autoCall}
                    markUnderway={tournament.markUnderway}
                    boardLimit={tournament.boardLimit}
                    playerPageHref={`/t/${tournament.publicSlug}`}
                    challongeHref={`https://challonge.com/${tournament.challongeUrl}`}
                  />
                  <AddStadiumButton tournamentId={tournament.id} />
                </div>
              </div>

              {room.totals.matches === 0 && (
                <p className="rounded-2xl border bg-card p-5 text-muted-foreground">
                  This tournament hasn&apos;t started on Challonge yet, so there are no matches. Start it there, then resync.
                </p>
              )}

              {cards.length === 0 && (
                <p className="text-muted-foreground">
                  Add a stadium for each Beyblade stadium at the venue. Ready matches are then sent to them.
                </p>
              )}
              <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]">
                {cards.map((card) => (
                  <StadiumCard
                    key={card.stadium.id}
                    tournamentId={tournament.id}
                    stadium={card.stadium}
                    now={card.now}
                    next={card.next}
                    autoCall={tournament.autoCall}
                    autoOnDeck={tournament.autoOnDeck}
                  />
                ))}
                <AddStadiumTile tournamentId={tournament.id} />
              </ul>
            </section>

            <section aria-labelledby="queue-heading" className="flex flex-col gap-4">
              <h2 id="queue-heading" className="font-display text-2xl font-semibold">
                Queue
              </h2>
              <QueueTable
                tournamentId={tournament.id}
                rows={queueRows}
                slots={cards.filter((c) => !c.hasOnDeck).map((c) => c.stadium)}
                autoOnDeck={tournament.autoOnDeck}
              />
            </section>

            <PlayersPanel tournamentId={tournament.id} players={playerRows} printHref={`/tournaments/${tournament.id}/passcodes`} />

            <details className="rounded-2xl border bg-card">
              <summary className="cursor-pointer px-5 py-4 font-display text-lg font-semibold">
                Completed <span className="text-muted-foreground">({room.completed.length})</span>
              </summary>
              {room.completed.length === 0 ? (
                <p className="border-t px-5 py-4 text-sm text-muted-foreground">No results yet.</p>
              ) : (
                <ul className="border-t">
                  {room.completed.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-3 text-sm last:border-b-0">
                      <span className="w-24 font-display font-semibold">{m.label}</span>
                      <span className="w-28 text-muted-foreground">{m.roundLabel}</span>
                      <span className="min-w-0 flex-1 font-semibold">
                        {m.player1} vs {m.player2}
                      </span>
                      <span className="text-muted-foreground">
                        {m.winner ? `${m.winner} won` : ""} {m.scores}
                      </span>
                      <ViewBattles matchId={m.id} label={m.label} players={`${m.player1} vs ${m.player2}`} />
                      <Link href={padHref(m.id)} className="font-semibold underline underline-offset-4">
                        Correct result
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </main>

          <aside className="flex min-w-0 flex-[1_1_20rem] flex-col gap-4 xl:max-w-sm">
            {problems.length > 0 && (
              <section aria-labelledby="problems-heading" className="flex flex-col gap-3 rounded-2xl border border-destructive/60 bg-destructive/15 p-5">
                <h2 id="problems-heading" className="flex items-center gap-2 font-display text-lg font-semibold">
                  <TriangleAlert className="size-5 text-destructive" aria-hidden />
                  {problems.length} result{problems.length === 1 ? "" : "s"} need{problems.length === 1 ? "s" : ""} you
                </h2>
                <ul className="flex flex-col gap-3">
                  {problems.map((issue) => {
                    const m = everyMatch.get(issue.matchId);
                    return (
                      <li key={issue.id} className="flex flex-col gap-2 text-sm">
                        <span className="font-semibold">{m ? `${m.label} · ${m.player1} vs ${m.player2}` : "Match"}</span>
                        <span className="text-muted-foreground">{issue.lastError}</span>
                        <div className="flex flex-wrap items-center gap-3">
                          {issue.status === "failed" && <RetryButton tournamentId={tournament.id} matchId={issue.matchId} />}
                          <Link href={padHref(issue.matchId)} className="font-semibold underline underline-offset-4">
                            Open pad
                          </Link>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <BoardsPanel tournamentId={tournament.id} link={boardShortLink(tournament.shortCode)} />

            <JudgesPanel tournamentId={tournament.id} link={judgeShortLink(tournament.shortCode)} stadiums={cards.length} />

            <WaitingPanel sending={sending} />

            <RuleCard
              tournamentId={tournament.id}
              current={tournament.ruleProfileId ? `profile:${tournament.ruleProfileId}` : `preset:${tournament.rulePresetKey}`}
              presets={Object.entries(PRESETS).map(([key, p]) => ({ value: `preset:${key}`, label: p.name }))}
              profiles={ownProfiles.map((p) => ({ value: `profile:${p.id}`, label: p.name }))}
              name={profile.name}
              points={profile.points}
              details={ruleDetails}
            />
          </aside>
        </div>
      </div>
    </AccessProvider>
  );
}
