"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize, Volume2, VolumeX } from "lucide-react";
import type { BoardMatch, BoardSnapshot, BoardStanding, BoardTable } from "@/lib/board";
import { callLabel } from "@/lib/call-label";
import { ordinal } from "@/lib/format";
import { useBoard } from "./use-board";

type Call = { key: string; stadium: string; match: BoardMatch };

const BANNER_MS = 3 * 60 * 1000;
/** "In the hole" and each standings table take turns in the same place. */
const ROTATE_MS = 15_000;
const callKey = (m: BoardMatch) => `${m.id}:${m.calledAt}`;
const names = (m: BoardMatch | null) =>
  m ? `${m.player1?.name ?? "TBD"} vs ${m.player2?.name ?? "TBD"}` : "—";

function currentCalls(snapshot: BoardSnapshot): Call[] {
  return snapshot.stadiums
    .filter((s) => s.now?.status === "called" && s.now.calledAt)
    .map((s) => ({ key: callKey(s.now!), stadium: s.name, match: s.now! }))
    .sort((a, b) => Date.parse(b.match.calledAt!) - Date.parse(a.match.calledAt!));
}

function chime(ctx: AudioContext) {
  const start = ctx.currentTime;
  [880, 1318.5].forEach((frequency, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = start + i * 0.28;
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.75);
  });
}

function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}

export function CallBoard({ slug, initial, qrSvg, playerUrl }: { slug: string; initial: BoardSnapshot; qrSvg: string; playerUrl: string }) {
  const { snapshot, online, denied } = useBoard(slug, initial, { realtime: true });
  const [soundOn, setSoundOn] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  // Calls already on screen when the board opened aren't announced again.
  const announced = useRef(new Set(currentCalls(initial).map((c) => c.key)));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // 0 is "In the hole"; 1 and on are the standings tables, in turn.
  const tableCount = snapshot.tables.length;
  const [panel, setPanel] = useState(0);
  useEffect(() => {
    if (tableCount === 0) return;
    const timer = setInterval(() => setPanel((p) => (p + 1) % (tableCount + 1)), ROTATE_MS);
    return () => clearInterval(timer);
  }, [tableCount]);
  const table = panel > 0 ? snapshot.tables[panel - 1] : undefined;

  useEffect(() => {
    const fresh = currentCalls(snapshot).filter((c) => !announced.current.has(c.key)).reverse();
    for (const call of fresh) {
      announced.current.add(call.key);
      if (soundOn && audio.current) {
        chime(audio.current);
        const lead = callLabel(call.match.callNumber) ?? "Now calling";
        setTimeout(() => speak(`${lead}, ${call.stadium}. ${names(call.match).replace(" vs ", " versus ")}.`), 900);
      }
    }
  }, [snapshot, soundOn]);

  // The organizer disconnected this screen: back to the pairing page, without asking again by itself.
  useEffect(() => {
    if (denied) window.location.replace(`/t/${slug}/board?disconnected=1`);
  }, [denied, slug]);

  const enableSound = async () => {
    if (soundOn) {
      setSoundOn(false);
      return;
    }
    audio.current ??= new AudioContext();
    await audio.current.resume();
    chime(audio.current);
    setSoundOn(true);
  };

  const latest = currentCalls(snapshot)[0];
  const banner = latest && now - Date.parse(latest.match.calledAt!) < BANNER_MS ? latest : null;

  return (
    <div className="flex min-h-svh flex-col gap-[2vh] bg-[#07090D] p-[2.5vw] text-foreground">
      <header className="flex flex-wrap items-center gap-x-8 gap-y-2">
        <h1 className="font-display text-[clamp(1.5rem,2.4vw,3rem)] font-bold">{snapshot.tournament.name}</h1>
        {/* Round of the most recently called match, as in the mockup's "Winners Round 2". */}
        <span className="flex-1 text-[clamp(1rem,1.5vw,1.9rem)] text-muted-foreground">
          {snapshot.standings ? "Final standings" : snapshot.currentRound}
        </span>
        <span
          className={`flex items-center gap-3 text-[clamp(1rem,1.3vw,1.6rem)] font-semibold ${online ? "text-success" : "text-warning"}`}
          role="status"
        >
          <span className={`size-3 rounded-full ${online ? "bg-success" : "bg-warning"}`} aria-hidden />
          {online ? "Live" : "Reconnecting…"}
        </span>
        <button
          type="button"
          onClick={() => void enableSound()}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border px-4 font-semibold"
        >
          {soundOn ? <Volume2 className="size-5" aria-hidden /> : <VolumeX className="size-5" aria-hidden />}
          {soundOn ? "Sound on" : "Enable sound"}
        </button>
        <button
          type="button"
          onClick={() => void document.documentElement.requestFullscreen?.()}
          aria-label="Full screen"
          className="inline-flex size-11 items-center justify-center rounded-full border"
        >
          <Maximize className="size-5" aria-hidden />
        </button>
      </header>

      {snapshot.standings && <Standings standings={snapshot.standings} />}

      {!snapshot.standings && banner && (
        <section
          aria-live="assertive"
          aria-label="Now calling"
          className="flex flex-wrap items-center gap-x-[2.5vw] gap-y-2 rounded-3xl bg-primary px-[2.1vw] py-[3vh] text-primary-foreground"
        >
          <div className="flex flex-col gap-1">
            <span className="text-[clamp(1rem,1.35vw,1.7rem)] font-bold uppercase tracking-[0.12em]">
              {callLabel(banner.match.callNumber) ?? "Now calling"}
            </span>
            <span className="font-display text-[clamp(2.5rem,4.6vw,6rem)] font-bold leading-[0.95]">{banner.stadium}</span>
          </div>
          <span aria-hidden className="w-1 self-stretch rounded-full bg-[#07090D]/25" />
          <span className="min-w-0 flex-1 font-display text-[clamp(2rem,5vw,6.5rem)] font-bold leading-none">
            {banner.match.player1?.name} <span className="text-[0.55em] opacity-60">vs</span> {banner.match.player2?.name}
          </span>
          <span className="flex flex-col text-right text-[clamp(1rem,1.45vw,1.8rem)] font-semibold leading-snug">
            <span>{banner.match.round}</span>
            <span>{banner.match.matchName}</span>
          </span>
        </section>
      )}

      {!snapshot.standings && (
        <div className="flex min-h-0 flex-1 flex-wrap gap-[2vw]">
          <div className="grid min-w-0 flex-[999_1_40rem] auto-rows-fr gap-[1.5vw] [grid-template-columns:repeat(auto-fit,minmax(min(100%,26rem),1fr))]">
            {snapshot.stadiums.length === 0 && (
              <p className="text-[clamp(1.25rem,2vw,2.5rem)] text-muted-foreground">Stadiums haven&apos;t been set up yet.</p>
            )}
            {snapshot.stadiums.map((s) => {
              const status = s.now?.status === "playing" ? "Playing" : s.now ? "Calling" : "Free";
              return (
                <article key={s.id} className="flex flex-col gap-[1.5vh] rounded-3xl border-2 border-[#232A35] bg-[#11151B] p-[1.6vw]">
                  <div className="flex items-center justify-between gap-4">
                    <h2 className="font-display text-[clamp(1.5rem,2.2vw,2.75rem)] font-bold">{s.name}</h2>
                    <span
                      className={`rounded-full px-4 py-1.5 text-[clamp(0.9rem,1.1vw,1.4rem)] font-bold uppercase tracking-wider ${
                        status === "Calling" ? "bg-primary text-primary-foreground" : status === "Playing" ? "bg-success-muted text-success" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {status}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[clamp(0.9rem,1vw,1.25rem)] font-bold uppercase tracking-widest text-muted-foreground">Now</span>
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-[clamp(1.4rem,2.1vw,2.6rem)] font-semibold">{names(s.now)}</span>
                      {s.now?.liveScore && (
                        <span className="font-display text-[clamp(1.6rem,2.3vw,2.9rem)] font-bold tabular-nums">{s.now.liveScore}</span>
                      )}
                    </div>
                    {s.now?.lastBattle && (
                      <span className="text-[clamp(0.9rem,1.1vw,1.4rem)] text-muted-foreground">
                        Latest battle: <span className="font-semibold text-[#D5DBE4]">{s.now.lastBattle}</span>
                      </span>
                    )}
                  </div>
                  <div className="h-0.5 bg-[#232A35]" />
                  <div className="flex flex-col gap-1">
                    <span className="text-[clamp(0.9rem,1vw,1.25rem)] font-bold uppercase tracking-widest text-muted-foreground">On deck</span>
                    <span className="text-[clamp(1.2rem,1.8vw,2.2rem)] text-[#D5DBE4]">{s.next ? names(s.next) : "—"}</span>
                  </div>
                </article>
              );
            })}
          </div>

          <aside className="flex min-w-0 flex-[1_1_22rem] flex-col gap-[1.5vw]">
            <section aria-label="Get notified" className="flex items-center gap-5 rounded-3xl bg-[#EEF1F5] p-[1.4vw] text-[#07090D]">
              <div
                role="img"
                aria-label={`QR code for ${playerUrl}`}
                className="size-[clamp(7rem,9vw,11rem)] shrink-0 [&>svg]:size-full"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
              <div className="flex flex-col gap-2">
                <span className="font-display text-[clamp(1.25rem,1.8vw,2.25rem)] font-bold leading-tight">Find your match</span>
                <span className="text-[clamp(1rem,1.15vw,1.4rem)] leading-snug">Scan, pick your name and enter your passcode.</span>
              </div>
            </section>
            {table ? (
              <RunningStandings table={table} />
            ) : (
              <section aria-label="In the hole" className="flex flex-1 flex-col gap-3 rounded-3xl border-2 border-[#232A35] bg-[#11151B] p-[1.4vw]">
                <h2 className="text-[clamp(1rem,1.2vw,1.5rem)] font-bold uppercase tracking-widest text-muted-foreground">In the hole</h2>
                {snapshot.queue.length === 0 && <p className="text-[clamp(1rem,1.2vw,1.5rem)] text-muted-foreground">Nothing waiting.</p>}
                {snapshot.queue.slice(0, 6).map((m) => (
                  <div key={m.id} className="flex flex-col border-b border-[#232A35] pb-3">
                    <span className="text-[clamp(1.2rem,1.6vw,2rem)] font-semibold">{names(m)}</span>
                    <span className="text-[clamp(0.9rem,1vw,1.25rem)] text-muted-foreground">{m.label}</span>
                  </div>
                ))}
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/** One running standings table, in the place of "In the hole". */
function RunningStandings({ table }: { table: BoardTable }) {
  return (
    <section aria-label={`Standings, ${table.title}`} className="flex flex-1 flex-col gap-3 rounded-3xl border-2 border-[#232A35] bg-[#11151B] p-[1.4vw]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="text-[clamp(1rem,1.2vw,1.5rem)] font-bold uppercase tracking-widest text-muted-foreground">
          Standings · <span className="text-foreground">{table.title}</span>
        </h2>
        <span className="text-[clamp(0.8rem,0.9vw,1.1rem)] text-muted-foreground">Wins, then Buchholz</span>
      </div>
      <ol className="flex flex-col">
        {table.rows.map((r) => (
          <li key={r.id} className="flex items-baseline gap-4 border-b border-[#232A35] py-[0.6vh] text-[clamp(1.1rem,1.4vw,1.8rem)]">
            <span className="w-[2.5ch] shrink-0 font-display font-bold tabular-nums text-muted-foreground">{r.rank}</span>
            <span className="min-w-0 flex-1 truncate font-semibold">{r.name}</span>
            {r.advanced && <span className="text-[0.7em] font-bold uppercase tracking-wider text-primary">Through</span>}
            <span className="font-display font-bold tabular-nums">{r.record}</span>
          </li>
        ))}
      </ol>
      {table.more > 0 && <p className="text-[clamp(0.9rem,1vw,1.25rem)] text-muted-foreground">+{table.more} more</p>}
    </section>
  );
}

const PODIUM = ["border-[#E8B923] text-[#E8B923]", "border-[#B9C2CF] text-[#B9C2CF]", "border-[#C98A52] text-[#C98A52]"];

/** The finalized tournament: the top three large, everyone else listed by placement. */
function Standings({ standings }: { standings: BoardStanding[] }) {
  const podium = standings.filter((s) => s.rank <= 3);
  const rest = standings.filter((s) => s.rank > 3);
  return (
    <section aria-label="Final standings" className="flex min-h-0 flex-1 flex-col gap-[2.5vh]">
      <ol className="grid gap-[1.5vw] [grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr))]">
        {podium.map((s) => (
          <li key={s.id} className={`flex flex-col gap-[1vh] rounded-3xl border-2 bg-[#11151B] p-[2vw] ${PODIUM[s.rank - 1] ?? PODIUM[2]}`}>
            <span className="font-display text-[clamp(1.5rem,2.6vw,3.4rem)] font-bold leading-none">{ordinal(s.rank)}</span>
            <span className="font-display text-[clamp(2rem,4vw,5.5rem)] font-bold leading-none text-foreground">{s.name}</span>
          </li>
        ))}
      </ol>
      {rest.length > 0 && (
        <ol className="gap-x-[3vw] rounded-3xl border-2 border-[#232A35] bg-[#11151B] p-[1.6vw] [column-width:16rem]">
          {rest.map((s) => (
            <li key={s.id} className="flex break-inside-avoid items-baseline gap-4 py-[0.6vh] text-[clamp(1.1rem,1.5vw,1.9rem)]">
              <span className="w-[4ch] shrink-0 font-display font-bold tabular-nums text-muted-foreground">{ordinal(s.rank)}</span>
              <span className="font-semibold">{s.name}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
