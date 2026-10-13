// A small in-memory Challonge for a Swiss tournament, reproducing what spikes S7 to S11 measured:
// only the current round exists, the next one is paired once the round's last result is in (and
// can be missing from a read made straight away), a result or a correction changes that match
// only, a player without an opponent gets no match, and a player who drops out is deactivated
// without changing the participant count while their open match is forfeited.
// It starts from a real 6-player tournament of 3 rounds recorded right after it started (S10).
import fixture from "../fixtures/challonge/swiss-tournament.json";

type Entry = { participant_id: string; score_set: string; rank: number; advancing: boolean };
type FakeMatch = {
  id: string;
  type: "match";
  attributes: {
    identifier: string;
    round: number;
    state: string;
    scores: string;
    suggested_play_order: number;
    score_in_sets: number[][];
    points_by_participant: { participant_id: number; scores: number[] }[];
    winner_id: number | null;
    tie: boolean;
  };
};
type FakeParticipant = {
  id: string;
  type: "participant";
  attributes: { name: string; seed: number; final_rank: number | null; states: { active: boolean } };
};

export function createFakeSwiss() {
  const recorded = structuredClone(fixture);
  const included = recorded.included as unknown as (FakeMatch | FakeParticipant | { id: string; type: "user" })[];
  const state = {
    tournament: { data: recorded.data },
    matches: included.filter((r): r is FakeMatch => r.type === "match"),
    participants: included.filter((r): r is FakeParticipant => r.type === "participant"),
    /** A round Challonge has paired that reads don't show yet, and how many more reads will miss it. */
    unseen: null as { matches: FakeMatch[]; reads: number } | null,
    /** How many reads of the matches miss a newly paired round. Challonge pairs it after answering the result. */
    pairingDelayReads: 0,
    etagVersion: 1,
    /** Every request made, as "METHOD /path". */
    requests: [] as string[],
    tournamentStateChanges: [] as string[],
  };
  const id = recorded.data.id;
  const slug = recorded.data.attributes.url;
  const etag = () => `W/"sw${state.etagVersion}"`;
  const every = () => [...state.matches, ...(state.unseen?.matches ?? [])];
  const byIdentifier = (identifier: string) => every().find((m) => m.attributes.identifier === identifier)!;
  const playersOf = (m: FakeMatch) => m.attributes.points_by_participant.map((p) => String(p.participant_id));
  const letters = (n: number) => String.fromCharCode(65 + n);

  /** A point for a win or for a round without an opponent, half for a tie. */
  function pointsOf(participantId: string) {
    const rounds = [...new Set(every().map((m) => m.attributes.round))];
    const played = every().filter((m) => m.attributes.state === "complete" && playersOf(m).includes(participantId));
    const wins = played.filter((m) => String(m.attributes.winner_id) === participantId).length;
    const ties = played.filter((m) => m.attributes.tie).length;
    const byes = rounds.filter((round) => !every().some((m) => m.attributes.round === round && playersOf(m).includes(participantId))).length;
    return wins + ties / 2 + byes;
  }

  /** Pairs the next round if the last one is finished and rounds remain. */
  function pairNextRound() {
    const all = every();
    const lastRound = Math.max(...all.map((m) => m.attributes.round));
    const rounds = recorded.data.attributes.swiss_options.rounds;
    if (lastRound >= rounds || all.some((m) => m.attributes.round === lastRound && m.attributes.state !== "complete")) return;

    const met = (a: string, b: string) => all.some((m) => playersOf(m).includes(a) && playersOf(m).includes(b));
    const waiting = state.participants
      .filter((p) => p.attributes.states.active)
      .sort((a, b) => pointsOf(b.id) - pointsOf(a.id) || a.attributes.seed - b.attributes.seed)
      .map((p) => p.id);
    const paired: FakeMatch[] = [];
    while (waiting.length > 1) {
      const first = waiting.shift()!;
      const at = Math.max(0, waiting.findIndex((other) => !met(first, other)));
      const [second] = waiting.splice(at, 1);
      const number = all.length + paired.length;
      paired.push({
        id: String(900000000 + number),
        type: "match",
        attributes: {
          identifier: letters(number),
          round: lastRound + 1,
          state: "open",
          scores: "0 - 0",
          suggested_play_order: number + 1,
          score_in_sets: [],
          points_by_participant: [
            { participant_id: Number(first), scores: [] },
            { participant_id: Number(second), scores: [] },
          ],
          winner_id: null,
          tie: false,
        },
      });
    }
    state.unseen = { matches: paired, reads: state.pairingDelayReads };
    state.etagVersion++;
  }

  function complete(match: FakeMatch, points: [number[], number[]], winnerId: number | null) {
    const [a, b] = match.attributes.points_by_participant;
    [a.scores, b.scores] = points;
    match.attributes.score_in_sets = a.scores.map((s, i) => [s, b.scores[i]]);
    match.attributes.scores = `${a.scores[0] ?? 0} - ${b.scores[0] ?? 0}`;
    match.attributes.winner_id = winnerId;
    match.attributes.tie = winnerId === null;
    match.attributes.state = "complete";
    state.etagVersion++;
    pairNextRound();
  }

  /** A player drops out, as on challonge.com: deactivated, and their open match forfeited to the opponent. */
  function drop(participantId: string) {
    state.participants.find((p) => p.id === participantId)!.attributes.states.active = false;
    const theirs = every().find((m) => m.attributes.state === "open" && playersOf(m).includes(participantId));
    if (theirs) complete(theirs, [[], []], Number(playersOf(theirs).find((p) => p !== participantId)));
  }

  /** What a read of the matches shows: a round paired a moment ago may not be in it yet. */
  function visibleMatches() {
    if (state.unseen && state.unseen.reads-- <= 0) {
      state.matches.push(...state.unseen.matches);
      state.unseen = null;
      state.etagVersion++;
    }
    return state.matches;
  }

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.pathname === "/oauth/token") {
      return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 604800, created_at: Math.floor(Date.now() / 1000) });
    }
    const path = url.pathname.replace(/^\/v2\.1/, "");
    const method = init?.method ?? "GET";
    state.requests.push(`${method} ${path}`);

    if (path === `/tournaments/${id}.json` || path === `/tournaments/${slug}.json`) return Response.json({ data: state.tournament.data });
    if (path === `/tournaments/${id}/participants.json`) return Response.json({ data: state.participants, links: { next: null } });
    if (path === `/tournaments/${id}/matches.json`) {
      const data = visibleMatches();
      if (headers["If-None-Match"] === etag()) return new Response(null, { status: 304, headers: { etag: etag() } });
      return Response.json({ data, links: { next: null } }, { headers: { etag: etag() } });
    }
    if (path === `/tournaments/${id}/change_state.json` && method === "PUT") {
      const requested = JSON.parse(String(init!.body)).data.attributes.state as string;
      state.tournamentStateChanges.push(requested);
      if (requested === "finalize") {
        if (every().some((m) => m.attributes.state === "open")) {
          return Response.json({ errors: [{ detail: "Tournament still has matches to play", status: 422 }] }, { status: 422 });
        }
        state.tournament.data.attributes.state = "complete";
        [...state.participants]
          .sort((a, b) => pointsOf(b.id) - pointsOf(a.id) || a.attributes.seed - b.attributes.seed)
          .forEach((p, i) => (p.attributes.final_rank = i + 1));
      }
      return Response.json({ data: state.tournament.data });
    }
    const put = path.match(new RegExp(`^/tournaments/${id}/matches/(\\d+)\\.json$`));
    if (put && method === "PUT") {
      const match = every().find((m) => m.id === put[1]);
      if (!match) return Response.json({ errors: [{ detail: "Not found" }] }, { status: 404 });
      const entries = JSON.parse(String(init!.body)).data.attributes.match as Entry[];
      const scoresOf = (participantId: number) => entries.find((e) => e.participant_id === String(participantId))!.score_set.split(",").map(Number);
      const [a, b] = match.attributes.points_by_participant;
      complete(match, [scoresOf(a.participant_id), scoresOf(b.participant_id)], Number(entries.find((e) => e.rank === 1)!.participant_id));
      return Response.json({ data: match });
    }
    return Response.json({ errors: [{ detail: `not stubbed: ${path}` }] }, { status: 404 });
  };

  return { state, fetch: fetchImpl, byIdentifier, drop, id, slug, rounds: (n: number) => (recorded.data.attributes.swiss_options.rounds = n) };
}
