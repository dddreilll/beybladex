// The tabs under the stadiums on the Desk, and which one is open. Pure, so the Desk and the tests share it.

export type DeskTab = "queue" | "standings" | "players" | "completed" | "bracket";

export const TAB_LABELS: Record<DeskTab, string> = {
  queue: "Queue",
  standings: "Standings",
  players: "Players",
  completed: "Completed",
  bracket: "Bracket",
};

/**
 * The tabs a tournament has. Before the start there is nothing to queue, play or draw yet: only the
 * players. Standings appear for the formats that have them.
 */
export function deskTabs(tournament: { pending: boolean; standings: boolean }): DeskTab[] {
  if (tournament.pending) return ["players"];
  return ["queue", ...(tournament.standings ? (["standings"] as const) : []), "players", "completed", "bracket"];
}

/** The tab asked for in the address (`?tab=players`) if the tournament has it, else the first. */
export function openTab(requested: string | string[] | undefined, tabs: DeskTab[]): DeskTab {
  return tabs.find((tab) => tab === requested) ?? tabs[0];
}
