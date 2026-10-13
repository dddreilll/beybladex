// Whether a tournament can be finalized, from what the app already knows (no Challonge request).

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What still stands in the way of finalizing; empty means ready.
 * Only *open* matches count as unplayed. A match left pending with nothing open is one Challonge
 * never opens: the last round of a bracket whose grand finals are set to None stays pending, and
 * Challonge finalizes all the same (spike S14). A grand-finals reset that isn't needed is removed
 * from the bracket (spike S16).
 */
export function finalizeBlockers(input: { matches: { state: string }[]; unsent: number }): string[] {
  const blockers: string[] = [];
  const open = input.matches.filter((m) => m.state === "open").length;
  if (!input.matches.some((m) => m.state === "complete")) blockers.push("No match has been played yet.");
  else if (open > 0) blockers.push(`${plural(open, "match", "matches")} still to play.`);
  if (input.unsent > 0) blockers.push(`${plural(input.unsent, "result isn't", "results aren't")} on Challonge yet.`);
  return blockers;
}
