import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Network } from "lucide-react";
import { and, asc, eq } from "drizzle-orm";
import { WarmPads } from "@/components/offline/outbox-sync";
import { PageHeader } from "@/components/page-shell";
import { accessOverview } from "@/lib/access";
import { requireOrganizer } from "@/lib/auth";
import { liveMatchInfo } from "@/lib/board";
import { callLabel } from "@/lib/call-label";
import { formatName, isFinished, isSwiss, stagePhase } from "@/lib/tournament/format";
import { setupProblems } from "@/lib/tournament/setup";
import { buildControlRoom, type QueueMatch } from "@/lib/control-room";
import { db } from "@/lib/db";
import { matches, participants, ruleProfiles, tournaments } from "@/lib/db/schema";
import { endGroupStageBlockers, finalizeBlockers } from "@/lib/finalize-check";
import { formatRelative, serverTime } from "@/lib/format";
import { tournamentProfile } from "@/lib/rules";
import { PRESETS } from "@/lib/scoring/profile";
import { standingsTables } from "@/lib/standings";
import { boardShortLink, judgeShortLink } from "@/lib/short-links";
import { listStadiums, RECALL_COOLDOWN_MS } from "@/lib/venue";
import { AccessProvider, BoardsPanel, JudgesPanel, PlayersPanel } from "./access-panels";
import { AddStadiumButton, AddStadiumTile } from "./add-stadium";
import { FinalizeButton } from "./finalize-button";
import { LiveRefresh } from "./live-refresh";
import { QueueTable, type QueueRow } from "./queue-table";
import { RuleCard } from "./rules-picker";
import { DeleteTournament, SetupPanel, StartButton } from "./setup-panel";
import { StageButton } from "./stage-button";
import { StadiumCard, type CardMatch, type CurrentMatch } from "./stadium-card";
import { StandingsPanel } from "./standings-panel";
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

  const [participantRows, matchRows, ownProfiles, profile, stadiumRows, access] = await Promise.all([
    db.select().from(participants).where(eq(participants.tournamentId, id)),
    db.select().from(matches).where(eq(matches.tournamentId, id)),
    db
      .select({ id: ruleProfiles.id, name: ruleProfiles.name })
      .from(ruleProfiles)
      .where(eq(ruleProfiles.organizerId, organizer.id))
      .orderBy(asc(ruleProfiles.name)),
    tournamentProfile(tournament),
    listStadiums(tournament.id),
    accessOverview(tournament.id, tournament.boardLimit),
  ]);
  const live = await liveMatchInfo(matchRows, new Map(participantRows.map((p) => [p.id, p.name])));
  const room = buildControlRoom(tournament, participantRows, matchRows);
  const padHref = (matchId: string) => `/tournaments/${tournament.id}/matches/${matchId}`;

  const finalized = isFinished(tournament.state);
  // A two-stage tournament is moved from its group stage to its final stage before it can be finished.
  const phase = stagePhase(tournament);
  const blockers = finalized ? [] : tournament.state === "pending" ? ["The tournament hasn't started yet."] : finalizeBlockers({ matches: matchRows, swissRounds: tournament.swissRounds, phase });
  const groupBlockers = phase === "groups" ? endGroupStageBlockers({ matches: matchRows.filter((m) => m.stage === "group") }) : [];
  const advancing = participantRows
    .filter((p) => p.advanced)
    .sort((a, b) => (a.finalSeed ?? 0) - (b.finalSeed ?? 0))
    .map((p) => p.name);
  const playerRows = participantRows
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, name: p.name, passcode: p.passcode, dropped: !p.active }));

  // Before the start: the players can still change, and Start stands where Finish will.
  const pending = tournament.state === "pending";
  const groupStage = tournament.groupStage ? { groups: tournament.groupCount ?? 0, advance: tournament.advancePerGroup ?? 0 } : null;
  const startBlockers = pending
    ? setupProblems({ format: tournament.tournamentType, players: participantRows.length, thirdPlace: tournament.thirdPlace, swissRounds: tournament.swissRounds, groupStage })
    : [];
  const summary = [
    groupStage && tournament.groupStageType ? `${groupStage.groups} groups of ${formatName(tournament.groupStageType).toLowerCase()}, top ${groupStage.advance} through, then ` : "",
    groupStage ? formatName(tournament.tournamentType).toLowerCase() : formatName(tournament.tournamentType),
    tournament.tournamentType === "double_elimination" ? (tournament.grandFinal === "reset" ? " · grand final may reset" : " · one grand final") : "",
    tournament.thirdPlace ? " · third-place match" : "",
    tournament.roundRobinLegs === 2 ? " · each pair meets twice" : "",
    tournament.tournamentType === "swiss" ? (tournament.swissRounds ? ` · ${tournament.swissRounds} rounds` : " · suggested rounds") : "",
  ].join("");

  const finalizeButton = (
    <FinalizeButton
      tournamentId={tournament.id}
      tournamentName={tournament.name}
      finalized={finalized}
      blockers={blockers}
    />
  );

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
          {/* In a two-stage tournament the two steps to the final stage stand where Finish is, until it has started. */}
          {pending ? (
            <StartButton tournamentId={tournament.id} tournamentName={tournament.name} players={participantRows.length} blockers={startBlockers} />
          ) : phase ? (
            <StageButton tournamentId={tournament.id} tournamentName={tournament.name} phase={phase} blockers={groupBlockers} advancing={advancing}>
              {finalizeButton}
            </StageButton>
          ) : (
            finalizeButton
          )}
        </PageHeader>

        <div className="flex flex-1 flex-wrap items-start gap-6 px-4 py-6 sm:px-6">
          <main className="flex min-w-0 flex-[999_1_36rem] flex-col gap-8">
            {pending && (
              <SetupPanel
                tournamentId={tournament.id}
                players={[...participantRows].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0)).map((p) => ({ id: p.id, name: p.name, seed: p.seed ?? 0 }))}
                summary={summary}
              />
            )}

            {phase === "between" && (
              <p role="status" className="rounded-xl border bg-card p-4 text-sm">
                <strong className="font-semibold">The group stage has ended.</strong>{" "}
                Going through to the final stage: {advancing.join(", ")}. Start the final stage when you&apos;re ready.
              </p>
            )}

            <section aria-labelledby="stadiums-heading" className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="stadiums-heading" className="font-display text-2xl font-semibold">
                  Stadiums
                </h2>
                <div className="flex flex-wrap items-center gap-4">
                  {!pending && (
                    <Link href={`/tournaments/${tournament.id}/bracket`} className="inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold">
                      <Network className="size-4" aria-hidden />
                      Bracket
                    </Link>
                  )}
                  <VenueSettings
                    tournamentId={tournament.id}
                    autoOnDeck={tournament.autoOnDeck}
                    autoCall={tournament.autoCall}
                    boardLimit={tournament.boardLimit}
                    playerPageHref={`/t/${tournament.publicSlug}`}
                  />
                  <AddStadiumButton tournamentId={tournament.id} />
                </div>
              </div>

              {room.totals.matches === 0 && (
                <p className="rounded-2xl border bg-card p-5 text-muted-foreground">
                  {pending ? "The matches are made when you start the tournament." : "This tournament has no matches yet."}
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
                    moveTargets={cards.filter((c) => !c.hasOnDeck && c.stadium.id !== card.stadium.id).map((c) => c.stadium)}
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

            <StandingsPanel tables={standingsTables(tournament, matchRows, participantRows)} />

            <PlayersPanel
              tournamentId={tournament.id}
              players={playerRows}
              printHref={`/tournaments/${tournament.id}/passcodes`}
              canDrop={!pending && !finalized}
              lateEntry={tournament.state === "underway" && !tournament.groupStage && isSwiss(tournament.tournamentType)}
            />

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
                        {m.winner} won {m.forfeit ? "by forfeit" : m.scores}
                      </span>
                      <ViewBattles matchId={m.id} label={m.label} players={`${m.player1} vs ${m.player2}`} />
                      {/* A finished tournament's results are fixed. */}
                      {!finalized && (
                        <Link href={padHref(m.id)} className="font-semibold underline underline-offset-4">
                          Correct result
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </details>

            <DeleteTournament tournamentId={tournament.id} tournamentName={tournament.name} />
          </main>

          <aside className="flex min-w-0 flex-[1_1_20rem] flex-col gap-4 xl:max-w-sm">
            <BoardsPanel tournamentId={tournament.id} link={boardShortLink(tournament.shortCode)} />

            <JudgesPanel tournamentId={tournament.id} link={judgeShortLink(tournament.shortCode)} stadiums={cards.length} />

            <WaitingPanel />

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
