import type { BoardMatch, BoardSnapshot } from "@/lib/board";

// What one signed-in player is sent: their own match and nothing about anyone else's.

export type PlayerMatch = {
  opponent: string;
  label: string;
  /** 1 for the first call, 2+ after the organizer recalled the players. */
  callNumber: number;
  liveScore: string | null;
};

export type PlayerStatus =
  | { kind: "called"; stadium: string; match: PlayerMatch }
  | { kind: "playing"; stadium: string; match: PlayerMatch }
  | { kind: "on_deck"; stadium: string; match: PlayerMatch }
  | { kind: "queued"; position: number; match: PlayerMatch }
  | { kind: "waiting"; match: PlayerMatch }
  /** The tournament is finalized. `rank` is null if Challonge gave this player no placement. */
  | { kind: "finished"; rank: number | null; of: number }
  | { kind: "idle" };

export type PlayerSnapshot = {
  version: number;
  tournament: { name: string };
  me: { id: string; name: string };
  status: PlayerStatus;
  /** Changes whenever one of this player's finished results does; the phone then reloads their battle scores. */
  results: string;
};

const involves = (m: BoardMatch | null, id: string) => Boolean(m && (m.player1?.id === id || m.player2?.id === id));

const own = (m: BoardMatch, id: string): PlayerMatch => ({
  opponent: (m.player1?.id === id ? m.player2?.name : m.player1?.name) ?? "TBD",
  label: m.label,
  callNumber: m.callNumber,
  liveScore: m.liveScore,
});

export function playerStatus(snapshot: BoardSnapshot, id: string): PlayerStatus {
  if (snapshot.standings) {
    return { kind: "finished", rank: snapshot.standings.find((s) => s.id === id)?.rank ?? null, of: snapshot.standings.length };
  }
  for (const s of snapshot.stadiums) {
    if (involves(s.now, id)) return { kind: s.now!.status === "playing" ? "playing" : "called", stadium: s.name, match: own(s.now!, id) };
  }
  for (const s of snapshot.stadiums) if (involves(s.next, id)) return { kind: "on_deck", stadium: s.name, match: own(s.next!, id) };
  const queued = snapshot.queue.findIndex((m) => involves(m, id));
  if (queued >= 0) return { kind: "queued", position: queued + 1, match: own(snapshot.queue[queued], id) };
  const waiting = snapshot.waiting.find((m) => involves(m, id));
  if (waiting) return { kind: "waiting", match: own(waiting, id) };
  return { kind: "idle" };
}
