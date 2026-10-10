// Stadium queue planner. Pure: given stadiums and matches, returns the assignment changes to make.
// Each active stadium has at most one current match (called or playing) and one on-deck match.

export type CallStatus = "none" | "on_deck" | "called" | "playing";

export type QueueStadium = { id: string; position: number; active: boolean };

export type QueueMatch = {
  id: string;
  state: string;
  player1: string | null;
  player2: string | null;
  playOrder: number | null;
  stadiumId: string | null;
  callStatus: CallStatus;
  held: boolean;
};

export type QueueChange = { matchId: string; stadiumId: string | null; callStatus: CallStatus };

const isCurrent = (m: QueueMatch) => m.callStatus === "called" || m.callStatus === "playing";
const playable = (m: QueueMatch) => m.state === "open" && Boolean(m.player1 && m.player2);

export type QueueOptions = {
  /** Call the on-deck match when its stadium is free. */
  autoCall: boolean;
  /** Pull the next ready match from the queue into empty slots. Off = the organizer places matches. */
  autoOnDeck: boolean;
  /** Matches to leave in the queue for this pass (just sent back by the organizer). */
  skip?: string[];
};

export function planQueue(stadiums: QueueStadium[], matches: QueueMatch[], options: QueueOptions): QueueChange[] {
  const working = new Map(matches.map((m) => [m.id, { ...m }]));
  const changes = new Map<string, QueueChange>();
  const set = (m: QueueMatch, stadiumId: string | null, callStatus: CallStatus) => {
    m.stadiumId = stadiumId;
    m.callStatus = callStatus;
    changes.set(m.id, { matchId: m.id, stadiumId, callStatus });
  };

  const active = stadiums.filter((s) => s.active).sort((a, b) => a.position - b.position);
  const activeIds = new Set(active.map((s) => s.id));

  // 1. Release assignments that no longer make sense: finished or reset matches, removed stadiums,
  //    held matches that were only on deck. (A held match that's already playing stays.)
  for (const m of working.values()) {
    if (m.callStatus === "none") continue;
    const gone = !m.stadiumId || !activeIds.has(m.stadiumId);
    if (!playable(m) || gone || (m.held && m.callStatus === "on_deck")) set(m, null, "none");
  }

  const all = [...working.values()];
  const busy = new Set(
    all.filter((m) => m.callStatus !== "none").flatMap((m) => [m.player1, m.player2]).filter(Boolean) as string[],
  );
  const skip = new Set(options.skip ?? []);
  const ready = all
    .filter((m) => m.callStatus === "none" && !m.held && !skip.has(m.id) && playable(m))
    .sort((a, b) => (a.playOrder ?? Number.MAX_SAFE_INTEGER) - (b.playOrder ?? Number.MAX_SAFE_INTEGER));

  // Next match whose players aren't already playing, called or on deck somewhere else.
  const takeNext = () => {
    if (!options.autoOnDeck) return null;
    const index = ready.findIndex((m) => !busy.has(m.player1!) && !busy.has(m.player2!));
    if (index < 0) return null;
    const [next] = ready.splice(index, 1);
    busy.add(next.player1!);
    busy.add(next.player2!);
    return next;
  };

  // 2. Fill stadiums in order: promote on-deck to current when free (auto-call), then refill on deck.
  for (const stadium of active) {
    const here = all.filter((m) => m.stadiumId === stadium.id);
    let current = here.find(isCurrent);
    let onDeck = here.find((m) => m.callStatus === "on_deck");

    if (!current && options.autoCall) {
      if (onDeck) {
        set(onDeck, stadium.id, "called");
        current = onDeck;
        onDeck = undefined;
      } else {
        const next = takeNext();
        if (next) {
          set(next, stadium.id, "called");
          current = next;
        }
      }
    }
    if (!onDeck) {
      const next = takeNext();
      if (next) set(next, stadium.id, "on_deck");
    }
  }

  return [...changes.values()].filter((c) => {
    const original = matches.find((m) => m.id === c.matchId)!;
    return original.stadiumId !== c.stadiumId || original.callStatus !== c.callStatus;
  });
}
