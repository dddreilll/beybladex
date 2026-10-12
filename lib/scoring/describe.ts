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

/** One battle as a row of a match's battle-by-battle score. */
export type SheetLine = {
  /** 1 for the first battle that counts. */
  number: number;
  /** 0 for the first set. */
  set: number;
  /** The player the battle is about: the scorer, or whoever made the launch error. Null for a draw. */
  who: string | null;
  /** "Xtreme", "Own finish", "Launch error", "Draw · replayed". */
  what: string;
  /** Small print under the line: a strike count, or who received a penalty point. */
  note: string | null;
  points: number;
  /** The set's score after this battle, player 1 first: "2–3". */
  score: string;
};

/** A battle's player and finish in words, without points (also used for battles that were undone). */
export function battleWords(battle: Battle, names: { 1: string; 2: string }): { who: string | null; what: string } {
  if (battle.kind === "draw") return { who: null, what: "Draw · replayed" };
  const who = battle.side ? names[battle.side] : null;
  return { who, what: battle.kind === "launch_error" ? "Launch error" : (FINISH_LABEL[battle.kind] ?? battle.kind) };
}

/**
 * Every battle of a match in order, each with the running score of its set.
 * Null when the battles can't be scored under these rules, so callers show nothing rather than
 * a wrong sheet.
 */
export function sheetLines(rules: MatchRules, battles: Battle[], names: { 1: string; 2: string }): SheetLine[] | null {
  let log;
  try {
    log = scoreMatch(rules, battles).log;
  } catch {
    return null;
  }
  let set = 0;
  let score = { 1: 0, 2: 0 };
  let strikes = { 1: 0, 2: 0 };

  return log.map((entry) => {
    if (entry.set !== set) {
      set = entry.set;
      score = { 1: 0, 2: 0 };
      strikes = { 1: 0, 2: 0 };
    }
    let note: string | null = null;
    if (entry.kind === "launch_error" && entry.side) {
      const needed = rules.launchErrorPenalty?.strikes;
      strikes[entry.side] += 1;
      if (entry.awardedTo) {
        note = `Strike ${strikes[entry.side]} of ${needed}: point to ${names[entry.awardedTo]}`;
        strikes[entry.side] = 0;
      } else if (needed) {
        note = `Strike ${strikes[entry.side]} of ${needed}`;
      }
    }
    if (entry.awardedTo) score[entry.awardedTo] += entry.points;
    return { number: entry.index + 1, set: entry.set, ...battleWords(entry, names), note, points: entry.points, score: `${score[1]}–${score[2]}` };
  });
}
