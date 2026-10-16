import { Badge } from "@/components/ui/badge";
import type { StandingsTable } from "@/lib/standings";

/**
 * Running standings by record, a table for each group, for the formats where everyone keeps
 * playing. Unofficial: Challonge decides the placements at Finalize, with its own tie-breaks.
 */
export function StandingsPanel({ tables }: { tables: StandingsTable[] }) {
  if (tables.length === 0) return null;
  return (
    <section aria-labelledby="standings-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="standings-heading" className="font-display text-2xl font-semibold">
          Standings
        </h2>
        <p className="text-sm text-muted-foreground">By record only. Not official: Challonge decides the placements at Finalize.</p>
      </div>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr))]">
        {tables.map((t) => (
          <div key={t.key} className="min-w-0 overflow-x-auto rounded-2xl border bg-card">
            <table className="w-full border-collapse text-sm">
              <caption className="px-5 pb-1 pt-4 text-left font-display text-lg font-semibold">
                {t.title}
                {!t.current && <span className="font-sans text-sm font-normal text-muted-foreground"> · ended</span>}
              </caption>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="w-12 px-5 py-2.5 font-semibold">
                    #
                  </th>
                  <th scope="col" className="py-2.5 font-semibold">
                    Player
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-right font-semibold">
                    Record
                  </th>
                </tr>
              </thead>
              <tbody>
                {t.rows.map((r) => (
                  <tr key={r.playerId} className="border-t">
                    <td className="px-5 py-2.5 font-display font-semibold tabular-nums text-muted-foreground">{r.rank}</td>
                    <td className="py-2.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{r.name}</span>
                        {r.advanced && <Badge variant="success">Advanced</Badge>}
                        {r.dropped && <Badge variant="muted">Dropped</Badge>}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-right font-semibold tabular-nums">{r.record}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}
