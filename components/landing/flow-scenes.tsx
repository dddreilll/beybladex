import type { CSSProperties, ReactNode } from "react";
import { ArrowUpFromLine, BellRing, Check, RotateCw, Sparkles, Zap } from "lucide-react";
import { interpolate, spring } from "remotion";
import { APP_NAME } from "@/lib/config";

// The landing page's animation, as a pure function of the frame number: one tap on the pad, the
// result on the bracket, the push on a phone, the call on the board. It is drawn from the app's own
// tokens on a fixed canvas, which the player scales to fit; sizes are in px for that reason.
// Every name in it is made up.

const SCENE_FRAMES = 60;
export const FLOW = { width: 600, height: 450, fps: 30, durationInFrames: SCENE_FRAMES * 4 };

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
type Spring = { damping: number; mass?: number };
const SETTLE: Spring = { damping: 200 };
const BOUNCE: Spring = { damping: 11, mass: 0.6 };
/** 0 to 1 on a spring curve, starting at frame `from`. */
const ease = (frame: number, from: number, config = SETTLE) => spring({ frame: frame - from, fps: FLOW.fps, config });

const eyebrow = "text-[18px] font-bold uppercase leading-none tracking-widest text-muted-foreground";

function Scene({ frame, label, dark = false, children }: { frame: number; label: string; dark?: boolean; children: ReactNode }) {
  const enter = ease(frame, 0);
  const exit = interpolate(frame, [SCENE_FRAMES - 8, SCENE_FRAMES], [1, 0], clamp);
  return (
    <div
      className={`${dark ? "dark " : ""}absolute inset-x-7 top-7 flex h-[326px] flex-col gap-5 rounded-3xl border bg-background p-6 text-foreground`}
      style={{ opacity: Math.min(enter, exit), transform: `translateY(${(1 - enter) * 28}px)` }}
    >
      <span className={eyebrow}>{label}</span>
      {children}
    </div>
  );
}

// Same finish colours as the real pad (components/judge/judge-pad.tsx).
const FINISHES = [
  { label: "Spin", color: "#8EB1FF", icon: RotateCw },
  { label: "Over", color: "#FBC54A", icon: ArrowUpFromLine },
  { label: "Burst", color: "#FF8A8A", icon: Sparkles },
  { label: "Xtreme", color: "#C9B6FF", icon: Zap },
];
const TAP = 22;

/** The judge taps Burst and the score goes from 3 to 5. Always dark, like the real pad. */
function PadScene({ frame }: { frame: number }) {
  const scored = frame >= TAP + 4;
  const pop = scored ? interpolate(ease(frame, TAP + 4, BOUNCE), [0, 1], [1.5, 1]) : 1;
  const press = interpolate(frame, [TAP - 2, TAP + 2, TAP + 8], [1, 0.93, 1], clamp);
  const finger = ease(frame, TAP - 12);
  const ripple = interpolate(frame, [TAP, TAP + 18], [0, 1], clamp);
  return (
    <Scene frame={frame} label={`${APP_NAME} Pad · Stadium 2`} dark>
      <div className="flex items-center justify-between font-display font-bold">
        <span className="text-[28px] text-[#2DD4BF]">Jordan</span>
        <span className="flex items-center gap-3 text-[56px] leading-none tabular-nums">
          <span style={{ transform: `scale(${pop})`, color: scored && pop > 1.02 ? "#FF8A8A" : undefined }}>{scored ? 5 : 3}</span>
          <span className="text-muted-foreground">–</span>
          <span>2</span>
        </span>
        <span className="text-[28px] text-[#F472B6]">Riley</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {FINISHES.map(({ label, color, icon: Icon }) => {
          const tapped = label === "Burst";
          return (
            <span
              key={label}
              style={{ color, borderColor: tapped && frame >= TAP - 2 ? color : undefined, transform: tapped ? `scale(${press})` : undefined }}
              className="relative flex items-center justify-center gap-2.5 overflow-hidden rounded-2xl border-2 bg-card py-3 text-[22px] font-bold"
            >
              <Icon className="size-6" />
              {label}
              {tapped && (
                <>
                  <span
                    className="absolute size-12 rounded-full bg-white"
                    style={{ opacity: 0.35 * finger * (1 - ripple), transform: `scale(${interpolate(finger, [0, 1], [1.6, 1])})` }}
                  />
                  <span className="absolute size-12 rounded-full border-2 border-white" style={{ opacity: 0.6 * (1 - ripple), transform: `scale(${1 + ripple * 5})` }} />
                </>
              )}
            </span>
          );
        })}
      </div>
    </Scene>
  );
}

/** The result lands on the bracket and the winner moves on. */
function BracketScene({ frame }: { frame: number }) {
  const sent = ease(frame, 14, BOUNCE);
  return (
    <Scene frame={frame} label={`${APP_NAME} Desk · Bracket`}>
      <div className="flex flex-col overflow-hidden rounded-2xl border bg-card text-[24px]">
        <span className="flex items-center justify-between px-5 py-3.5 font-semibold">
          <span className="flex items-center gap-3">
            <Check className="size-7 text-success" style={{ transform: `scale(${sent})` }} />
            Jordan
          </span>
          <span className="font-display font-bold tabular-nums">5</span>
        </span>
        <span className="flex items-center justify-between border-t px-5 py-3.5 text-muted-foreground">
          <span className="pl-10">Riley</span>
          <span className="font-display font-bold tabular-nums">2</span>
        </span>
      </div>
      <span
        className="self-start rounded-full bg-success-muted px-5 py-2 text-[20px] font-bold text-success"
        style={{ opacity: Math.min(1, sent * 2), transform: `scale(${sent})`, transformOrigin: "left center" }}
      >
        Result saved
      </span>
      <span className="text-[20px] text-muted-foreground" style={{ opacity: interpolate(frame, [28, 38], [0, 1], clamp) }}>
        Jordan moves on to Winners R2.
      </span>
    </Scene>
  );
}

function Push({ title, body, style }: { title: string; body: string; style: CSSProperties }) {
  return (
    <div className="absolute inset-x-0 top-0 flex flex-col gap-1.5 rounded-2xl border bg-card p-5 shadow-md" style={style}>
      <span className="flex items-center justify-between text-[18px] leading-none text-muted-foreground">
        <span className="flex items-center gap-2 font-semibold">
          <span className="size-4 rounded-full border-[3px] border-primary-text" />
          {APP_NAME}
        </span>
        now
      </span>
      <span className="text-[27px] font-semibold leading-tight">{title}</span>
      <span className="text-[20px] leading-snug text-muted-foreground">{body}</span>
    </div>
  );
}

/** "On deck" gives way to "You're up", worded like the real pushes (lib/push-endpoint.ts). */
function PushScene({ frame }: { frame: number }) {
  const leave = interpolate(frame, [16, 24], [0, 1], clamp);
  const arrive = ease(frame, 22, { damping: 14, mass: 0.7 });
  const go = ease(frame, 34, BOUNCE);
  return (
    <Scene frame={frame} label={`${APP_NAME} Pass · Alex's phone`}>
      <div className="relative h-[142px]">
        <Push
          title="On deck at Stadium 2"
          body="vs Sam · Winners R1. You play after the current match."
          style={{ opacity: 1 - leave, transform: `translateY(${leave * -16}px)` }}
        />
        <Push
          title="You're up at Stadium 2"
          body="vs Sam · Winners R1. Head there now."
          // A short drop: the card must not slide over the label above it.
          style={{ opacity: Math.min(1, arrive * 1.5), transform: `translateY(${(1 - arrive) * -16}px) scale(${interpolate(arrive, [0, 1], [0.94, 1])})` }}
        />
      </div>
      <span
        className="rounded-2xl bg-primary px-5 py-3.5 text-[22px] font-bold text-primary-foreground"
        style={{ opacity: Math.min(1, go * 2), transform: `scale(${interpolate(go, [0, 1], [0.9, 1])})` }}
      >
        Go to Stadium 2 now.
      </span>
    </Scene>
  );
}

/** A free stadium flips to the call, and the board chimes. Always dark, like the real board. */
function BoardScene({ frame }: { frame: number }) {
  const fold = interpolate(frame, [10, 18], [0, 90], clamp);
  const unfold = interpolate(ease(frame, 18, { damping: 13, mass: 0.7 }), [0, 1], [-90, 0]);
  const pulse = 1 + 0.03 * Math.sin(interpolate(frame, [22, 46], [0, Math.PI * 3], clamp));
  const ring = (from: number) => interpolate(frame, [from, from + 22], [0, 1], clamp);
  const banner = "absolute inset-0 flex items-center justify-between rounded-2xl px-6";
  return (
    <Scene frame={frame} label={`${APP_NAME} Board · Venue TV`} dark>
      <div className="relative h-[124px]" style={{ perspective: 900 }}>
        {frame < 18 ? (
          <div className={`${banner} border bg-card`} style={{ transform: `rotateX(${fold}deg)` }}>
            <span className="font-display text-[34px] font-bold">Stadium 2</span>
            <span className="rounded-full bg-muted px-4 py-1.5 text-[18px] font-bold uppercase tracking-wider text-muted-foreground">Free</span>
          </div>
        ) : (
          <div className={`${banner} bg-primary text-primary-foreground`} style={{ transform: `rotateX(${unfold}deg) scale(${pulse})` }}>
            <span className="flex flex-col gap-2">
              <span className="text-[18px] font-bold uppercase leading-none tracking-widest">Now calling · Stadium 2</span>
              <span className="font-display text-[42px] font-bold leading-none">
                Alex <span className="text-[24px] opacity-60">vs</span> Sam
              </span>
            </span>
            <span className="relative flex size-14 items-center justify-center">
              {[24, 34].map((from) => (
                <span
                  key={from}
                  className="absolute inset-0 rounded-full border-[3px] border-primary-foreground"
                  style={{ opacity: 0.5 * (1 - ring(from)), transform: `scale(${1 + ring(from) * 0.9})` }}
                />
              ))}
              <BellRing className="size-9" style={{ transform: `rotate(${12 * Math.sin(interpolate(frame, [22, 46], [0, Math.PI * 4], clamp))}deg)` }} />
            </span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2.5 rounded-2xl border bg-card p-4">
          <span className={eyebrow}>On deck</span>
          <span className="text-[23px] font-semibold leading-none">Quinn vs Drew</span>
        </div>
        <div className="flex flex-col gap-2.5 rounded-2xl border bg-card p-4">
          <span className={eyebrow}>In the hole</span>
          <span className="text-[23px] font-semibold leading-none">Casey vs Robin</span>
        </div>
      </div>
    </Scene>
  );
}

const SCENES = [
  { label: "Pad", scene: PadScene },
  { label: "Bracket", scene: BracketScene },
  { label: "Pass", scene: PushScene },
  { label: "Board", scene: BoardScene },
];

export function FlowFrame({ frame }: { frame: number }) {
  const active = Math.min(SCENES.length - 1, Math.floor(frame / SCENE_FRAMES));
  const Active = SCENES[active].scene;
  return (
    <div aria-hidden className="relative bg-card font-sans text-foreground" style={{ width: FLOW.width, height: FLOW.height }}>
      <Active frame={frame - active * SCENE_FRAMES} />
      <div className="absolute inset-x-7 bottom-7 flex gap-2">
        {SCENES.map(({ label }, index) => (
          <span
            key={label}
            className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-[18px] font-bold ${
              index === active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}
          >
            <span className="opacity-60">{index + 1}</span>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
