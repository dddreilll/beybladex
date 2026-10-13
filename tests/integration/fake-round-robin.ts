// A small in-memory Challonge for a round robin, reproducing what spike S7 measured: every match
// is open from the start, a result or a correction changes that match and nothing else, a tie
// completes a match without a winner, and finalizing gives every participant a placement.
// It starts from a real 4-player tournament recorded right after it started.
import fixture from "../fixtures/challonge/round-robin-tournament.json";

type Entry = { participant_id: string; score_set: string; rank: number; advancing: boolean };
type FakeMatch = {
  id: string;
  type: "match";
  attributes: {
    identifier: string;
    state: string;
    scores: string;
    score_in_sets: number[][];
    points_by_participant: { participant_id: number; scores: number[] }[];
    winner_id: number | null;
    tie: boolean;
  };
};
type FakeParticipant = { id: string; type: "participant"; attributes: { name: string; seed: number; final_rank: number | null } };

export function createFakeRoundRobin() {
  const recorded = structuredClone(fixture);
  const included = recorded.included as unknown as (FakeMatch | FakeParticipant | { id: string; type: "user" })[];
  const state = {
    tournament: { data: recorded.data },
    matches: included.filter((r): r is FakeMatch => r.type === "match"),
    participants: included.filter((r): r is FakeParticipant => r.type === "participant"),
    etagVersion: 1,
    /** Answer 200 to a result without applying it. */
    ignorePuts: false,
    /** Every request made, as "METHOD /path". */
    requests: [] as string[],
    tournamentStateChanges: [] as string[],
  };
  const id = recorded.data.id;
  const slug = recorded.data.attributes.url;
  const etag = () => `W/"rr${state.etagVersion}"`;
  const byIdentifier = (identifier: string) => state.matches.find((m) => m.attributes.identifier === identifier)!;

  function complete(match: FakeMatch, points: [number[], number[]], winnerId: number | null) {
    const [a, b] = match.attributes.points_by_participant;
    [a.scores, b.scores] = points;
    match.attributes.score_in_sets = a.scores.map((s, i) => [s, b.scores[i]]);
    match.attributes.scores = `${a.scores[0]} - ${b.scores[0]}`;
    match.attributes.winner_id = winnerId;
    match.attributes.tie = winnerId === null;
    match.attributes.state = "complete";
    state.etagVersion++;
  }

  /** Enters a tie, as an organizer can on challonge.com; the pad never sends one. */
  function tie(identifier: string) {
    complete(byIdentifier(identifier), [[3], [3]], null);
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
      if (headers["If-None-Match"] === etag()) return new Response(null, { status: 304, headers: { etag: etag() } });
      return Response.json({ data: state.matches, links: { next: null } }, { headers: { etag: etag() } });
    }
    if (path === `/tournaments/${id}/change_state.json` && method === "PUT") {
      const requested = JSON.parse(String(init!.body)).data.attributes.state as string;
      state.tournamentStateChanges.push(requested);
      if (requested === "finalize") {
        if (state.matches.some((m) => m.attributes.state === "open")) {
          return Response.json({ errors: [{ detail: "Tournament still has matches to play", status: 422 }] }, { status: 422 });
        }
        state.tournament.data.attributes.state = "complete";
        // Placements by matches won, then by seed.
        const wins = (p: FakeParticipant) => state.matches.filter((m) => String(m.attributes.winner_id) === p.id).length;
        [...state.participants]
          .sort((a, b) => wins(b) - wins(a) || a.attributes.seed - b.attributes.seed)
          .forEach((p, i) => (p.attributes.final_rank = i + 1));
      }
      return Response.json({ data: state.tournament.data });
    }
    const put = path.match(new RegExp(`^/tournaments/${id}/matches/(\\d+)\\.json$`));
    if (put && method === "PUT") {
      const match = state.matches.find((m) => m.id === put[1]);
      if (!match) return Response.json({ errors: [{ detail: "Not found" }] }, { status: 404 });
      const entries = JSON.parse(String(init!.body)).data.attributes.match as Entry[];
      if (!state.ignorePuts) {
        const pointsOf = (participantId: number) => entries.find((e) => e.participant_id === String(participantId))!.score_set.split(",").map(Number);
        const [a, b] = match.attributes.points_by_participant;
        complete(match, [pointsOf(a.participant_id), pointsOf(b.participant_id)], Number(entries.find((e) => e.rank === 1)!.participant_id));
      }
      return Response.json({ data: match });
    }
    return Response.json({ errors: [{ detail: `not stubbed: ${path}` }] }, { status: 404 });
  };

  return { state, fetch: fetchImpl, byIdentifier, tie, id, slug };
}
