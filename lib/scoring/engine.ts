import type { Finish, MatchRules } from "./profile";

export type Side = 1 | 2;
export type BattleKind = Finish | "own" | "launch_error" | "draw";
/** For finishes and "own", `side` is the player who scores. For launch errors, the player who erred. */
export type Battle = { kind: BattleKind; side: Side | null };

export type SetScore = { 1: number; 2: number; winner: Side | null };

export type LogEntry = {
  index: number;
  set: number;
  kind: BattleKind;
  side: Side | null;
  /** Who received points from this battle (the opponent, for a penalised launch error). */
  awardedTo: Side | null;
  points: number;
};

export type MatchScore = {
  sets: SetScore[];
  /** Index of the set in progress, or of the last set once the match is decided. */
  currentSet: number;
  setsWon: { 1: number; 2: number };
  setsToWin: number;
  strikes: { 1: number; 2: number };
  winner: Side | null;
  complete: boolean;
  log: LogEntry[];
};

export class ScoringError extends Error {
  name = "ScoringError";
}

const other = (side: Side): Side => (side === 1 ? 2 : 1);

export function scoreMatch(rules: MatchRules, battles: Battle[]): MatchScore {
  const setsToWin = Math.ceil(rules.bestOfSets / 2);
  const sets: SetScore[] = [{ 1: 0, 2: 0, winner: null }];
  const setsWon = { 1: 0, 2: 0 };
  let strikes = { 1: 0, 2: 0 };
  let winner: Side | null = null;
  const log: LogEntry[] = [];

  battles.forEach((battle, index) => {
    if (winner) throw new ScoringError("The match is already decided.");
    const set = sets[sets.length - 1];
    const entry: LogEntry = { index, set: sets.length - 1, kind: battle.kind, side: battle.side, awardedTo: null, points: 0 };

    if (battle.kind === "draw") {
      log.push(entry);
      return;
    }
    if (battle.side !== 1 && battle.side !== 2) throw new ScoringError(`A ${battle.kind} battle needs a player.`);

    if (battle.kind === "launch_error") {
      const penalty = rules.launchErrorPenalty;
      if (!penalty) throw new ScoringError("Launch errors aren't used by this rule profile.");
      strikes[battle.side] += 1;
      if (strikes[battle.side] >= penalty.strikes) {
        strikes[battle.side] = 0;
        entry.awardedTo = other(battle.side);
        entry.points = penalty.points;
      }
    } else if (battle.kind === "own") {
      if (rules.ownFinishPoints == null) throw new ScoringError("Own finishes aren't used by this rule profile.");
      entry.awardedTo = battle.side;
      entry.points = rules.ownFinishPoints;
    } else {
      entry.awardedTo = battle.side;
      entry.points = rules.points[battle.kind];
    }

    if (entry.awardedTo) set[entry.awardedTo] += entry.points;
    log.push(entry);

    if (entry.awardedTo && set[entry.awardedTo] >= rules.targetPoints) {
      set.winner = entry.awardedTo;
      setsWon[entry.awardedTo] += 1;
      if (setsWon[entry.awardedTo] >= setsToWin) {
        winner = entry.awardedTo;
      } else {
        sets.push({ 1: 0, 2: 0, winner: null });
        strikes = { 1: 0, 2: 0 };
      }
    }
  });

  return { sets, currentSet: sets.length - 1, setsWon, setsToWin, strikes, winner, complete: winner !== null, log };
}

/** Per-player set scores: one number per completed set, comma-separated. */
export function scoreSets(rules: MatchRules, score: MatchScore): { 1: string; 2: string } {
  const finished = score.sets.filter((s) => s.winner);
  const value = (s: SetScore, side: Side) => (rules.capAtTarget ? Math.min(s[side], rules.targetPoints) : s[side]);
  return {
    1: finished.map((s) => value(s, 1)).join(","),
    2: finished.map((s) => value(s, 2)).join(","),
  };
}

/** A decided match's score as players read it, player 1 first: "4-2", or "4-1,2-4,4-3" with sets. */
export function scoreText(rules: MatchRules, score: MatchScore): string {
  if (!score.winner) throw new ScoringError("The match isn't decided yet.");
  const sets = scoreSets(rules, score);
  const one = sets[1].split(",");
  const two = sets[2].split(",");
  return one.map((points, i) => `${points}-${two[i]}`).join(",");
}
