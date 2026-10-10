import { scoreMatch, type Battle } from "./engine";
import type { MatchRules, RuleProfile } from "./profile";

/** One-line summary of a profile for lists and the control room. */
export function describeProfile(p: RuleProfile): string {
  const parts = [
    `Spin ${p.points.spin} · Over ${p.points.over} · Burst ${p.points.burst} · Xtreme ${p.points.xtreme}`,
    `first to ${p.targetPoints}${p.bestOfSets > 1 ? `, best of ${p.bestOfSets}` : ""}`,
  ];
  if (p.ownFinishPoints != null) parts.push(`own finish +${p.ownFinishPoints}`);
  if (p.launchErrorPenalty) parts.push(`${p.launchErrorPenalty.strikes} launch errors = +${p.launchErrorPenalty.points} to opponent`);
  if (p.finals) parts.push(`finals: first to ${p.finals.targetPoints}, best of ${p.finals.bestOfSets}`);
  if (p.capAtTarget) parts.push("scores capped at target");
  return parts.join(" · ");
}

const FINISH_LABEL: Record<string, string> = { spin: "Spin", over: "Over", burst: "Burst", xtreme: "Xtreme", own: "Own finish" };

/**
 * What happened in the most recent battle, for boards and stadium cards:
 * "Alex · Xtreme +3", "Draw · replayed", "Sam launch error · +1 Alex",
 * "Sam launch error (strike 1 of 2)". Null when nothing has been recorded.
 */
export function lastBattleText(rules: MatchRules, battles: Battle[], names: { 1: string; 2: string }): string | null {
  if (battles.length === 0) return null;
  let score;
  try {
    score = scoreMatch(rules, battles);
  } catch {
    return null;
  }
  const last = score.log.at(-1);
  if (!last) return null;
  if (last.kind === "draw") return "Draw · replayed";
  if (!last.side) return null;

  if (last.kind === "launch_error") {
    if (last.awardedTo) return `${names[last.side]} launch error · +${last.points} ${names[last.awardedTo]}`;
    const needed = rules.launchErrorPenalty?.strikes;
    return `${names[last.side]} launch error${needed ? ` (strike ${score.strikes[last.side]} of ${needed})` : ""}`;
  }
  return `${names[last.side]} · ${FINISH_LABEL[last.kind] ?? last.kind} +${last.points}`;
}
