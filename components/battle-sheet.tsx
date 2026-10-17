import type { MatchSheet, SheetEntry } from "@/lib/battle-sheet";
import { cn } from "@/lib/utils";

/** "4–3", player 1 first; nothing when the score isn't in the usual form. */
export const sheetScore = (sheet: MatchSheet) => (sheet.score ? `${sheet.score[1]}–${sheet.score[2]}` : null);

const row = "grid grid-cols-[2.25rem_minmax(0,1fr)_2.5rem_3rem] items-baseline gap-x-2 border-t py-2 text-sm first:border-t-0";

type Item = { kind: "set"; set: number } | { kind: "entry"; entry: SheetEntry };

/**
 * A match's battles in the order they were played: number, player, finish, points, and the score
 * after each one. Multi-set matches get a heading per set. Battles that were undone appear only
 * when `showVoided` is set (the control room's switch), struck through with the reason.
 */
export function BattleSheet({ sheet, showVoided = false }: { sheet: MatchSheet; showVoided?: boolean }) {
  const entries = sheet.entries.filter((e) => e.type === "battle" || showVoided);
  const lines = sheet.entries.flatMap((e) => (e.type === "battle" ? [e.line] : []));
  const multiSet = lines.some((l) => l.set > 0);
  // A set's final score is the running score of its last battle.
  const setScore = (set: number) => lines.filter((l) => l.set === set).at(-1)?.score;

  const items: Item[] = [];
  let headed = -1;
  for (const entry of entries) {
    if (multiSet && entry.type === "battle" && entry.line.set !== headed) {
      headed = entry.line.set;
      items.push({ kind: "set", set: headed });
    }
    items.push({ kind: "entry", entry });
  }

  return (
    <div className="flex flex-col gap-2">
      {!sheet.recorded && <p className="text-sm text-muted-foreground">No battle record for this match.</p>}
      {items.length > 0 && (
        <ol aria-label={`Battles, ${sheet.players[1]} against ${sheet.players[2]}`} className="flex flex-col">
          {items.map((item, i) => {
            if (item.kind === "set") {
              return (
                <li
                  key={i}
                  className="flex items-baseline justify-between border-t pb-1 pt-3 text-xs font-bold uppercase tracking-widest text-muted-foreground first:border-t-0 first:pt-0"
                >
                  <span>Set {item.set + 1}</span>
                  <span className="tabular-nums">{setScore(item.set)}</span>
                </li>
              );
            }
            const { entry } = item;
            if (entry.type === "voided") {
              return (
                <li key={i} className={cn(row, "text-muted-foreground")}>
                  <span aria-hidden>—</span>
                  <span className="min-w-0">
                    <s>
                      {entry.who && `${entry.who} `}
                      {entry.what}
                    </s>
                    <span className="block text-xs">{entry.reason}</span>
                  </span>
                </li>
              );
            }
            const { line } = entry;
            return (
              <li key={i} className={row}>
                <span className="font-display text-muted-foreground">B{line.number}</span>
                <span className="min-w-0">
                  {line.who && <span className="font-semibold">{line.who} </span>}
                  <span className={line.who ? "text-muted-foreground" : undefined}>{line.what}</span>
                  {line.note && <span className="block text-xs text-muted-foreground">{line.note}</span>}
                </span>
                <span className="text-right font-bold tabular-nums">{line.points > 0 ? `+${line.points}` : ""}</span>
                <span className="text-right font-display font-semibold tabular-nums">{line.score}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
