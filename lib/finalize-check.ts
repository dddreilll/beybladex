// Whether a tournament can be finalized, from what the app already knows (no Challonge request).

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What still stands in the way of finalizing; empty means ready.
 * Only *open* matches count as unplayed. A match left pending with nothing open is one Challonge
 * no longer needs (the grand-finals reset when the winners-side finalist takes the first match).
 */
export function finalizeBlockers(input: { matches: { state: string }[]; unsent: number }): string[] {
  const blockers: string[] = [];
  const open = input.matches.filter((m) => m.state === "open").length;
  if (!input.matches.some((m) => m.state === "complete")) blockers.push("No match has been played yet.");
  else if (open > 0) blockers.push(`${plural(open, "match", "matches")} still to play.`);
  if (input.unsent > 0) blockers.push(`${plural(input.unsent, "result isn't", "results aren't")} on Challonge yet.`);
  return blockers;
}
