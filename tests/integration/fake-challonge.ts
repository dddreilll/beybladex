// A small in-memory Challonge that reproduces the behaviour measured in the spikes (S4, S4b):
// a report moves the winner/loser into their next matches, flipping a winner wipes completed
// downstream matches, and a tie on an elimination match returns 200 without being applied.
import matchesFixture from "../fixtures/challonge/matches-started.json";
import participantsFixture from "../fixtures/challonge/participants.json";
import tournamentFixture from "../fixtures/challonge/tournament.json";

type Entry = { participant_id: string; score_set: string; rank: number; advancing: boolean };
type MatchJson = (typeof matchesFixture)["data"][number];

// Real bracket links observed for this fixture (winner slot, loser slot).
const FEEDS: Record<string, { winner: [string, 0 | 1]; loser: [string, 0 | 1] }> = {
  A: { winner: ["I", 0], loser: ["R", 0] },
  B: { winner: ["I", 1], loser: ["R", 1] },
  I: { winner: ["M", 0], loser: ["Y", 0] },
};

export function createFakeChallonge() {
  const state = {
    matches: structuredClone(matchesFixture) as { data: MatchJson[] } & Record<string, unknown>,
    etagVersion: 1,
    failPut: null as number | null,
    ignorePuts: false,
    puts: [] as { matchId: string; entries: Entry[] }[],
    stateChanges: [] as { matchId: string; state: string }[],
    tokenCalls: 0,
  };

  const byIdentifier = (identifier: string) => state.matches.data.find((m) => m.attributes.identifier === identifier)!;
  const etag = () => `W/"v${state.etagVersion}"`;
  const slotsOf = (m: MatchJson) => m.attributes.points_by_participant as { participant_id: number | null; scores: number[] }[];

  function settleStates() {
    for (const m of state.matches.data) {
      if (m.attributes.state === "complete") continue;
      const [a, b] = slotsOf(m);
      m.attributes.state = a.participant_id && b.participant_id ? "open" : "pending";
    }
  }

  function clearSlot([identifier, slot]: [string, 0 | 1]) {
    slotsOf(byIdentifier(identifier))[slot].participant_id = null;
  }

  function reset(m: MatchJson) {
    const feeds = FEEDS[m.attributes.identifier];
    m.attributes.state = "pending";
    (m.attributes as { winner_id: number | null }).winner_id = null;
    m.attributes.scores = "0 - 0";
    if (feeds) {
      const after = [feeds.winner, feeds.loser];
      for (const target of after) {
        const next = byIdentifier(target[0]);
        if (next.attributes.state === "complete") reset(next);
        clearSlot(target);
      }
    }
  }

  function report(m: MatchJson, entries: Entry[]) {
    if (entries[0].rank === entries[1].rank) {
      // Ties are stored as scores but the match stays open (spike S4).
      m.attributes.scores = `${entries[0].score_set} - ${entries[1].score_set}`;
      return;
    }
    const winner = entries.find((e) => e.advancing)!;
    const loser = entries.find((e) => !e.advancing)!;
    const previousWinner = (m.attributes as { winner_id: number | null }).winner_id;
    const feeds = FEEDS[m.attributes.identifier];

    if (previousWinner && String(previousWinner) !== winner.participant_id && feeds) {
      for (const target of [feeds.winner, feeds.loser]) {
        const next = byIdentifier(target[0]);
        if (next.attributes.state === "complete") reset(next);
      }
    }
    m.attributes.state = "complete";
    (m.attributes as { winner_id: number | null }).winner_id = Number(winner.participant_id);
    const [p1] = slotsOf(m);
    const first = String(p1.participant_id) === winner.participant_id ? winner : loser;
    const second = first === winner ? loser : winner;
    // Challonge shows sets won for multi-set results (spike S4), raw points otherwise.
    const setsWon = (mine: string, theirs: string) =>
      mine.split(",").filter((v, i) => Number(v) > Number(theirs.split(",")[i])).length;
    m.attributes.scores = first.score_set.includes(",")
      ? `${setsWon(first.score_set, second.score_set)} - ${setsWon(second.score_set, first.score_set)}`
      : `${first.score_set} - ${second.score_set}`;
    if (feeds) {
      slotsOf(byIdentifier(feeds.winner[0]))[feeds.winner[1]].participant_id = Number(winner.participant_id);
      slotsOf(byIdentifier(feeds.loser[0]))[feeds.loser[1]].participant_id = Number(loser.participant_id);
    }
    settleStates();
  }

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.pathname === "/oauth/token") {
      state.tokenCalls++;
      return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 604800, created_at: Math.floor(Date.now() / 1000) });
    }
    const path = url.pathname.replace(/^\/v2\.1/, "");
    if (path === "/tournaments/xl4tobg6.json" || path === "/tournaments/18602864.json") return Response.json(tournamentFixture);
    if (path === "/tournaments/18602864/participants.json") return Response.json(participantsFixture);
    if (path === "/tournaments/18602864/matches.json") {
      if (headers["If-None-Match"] === etag()) return new Response(null, { status: 304, headers: { etag: etag() } });
      return Response.json({ ...state.matches, links: { next: null } }, { headers: { etag: etag() } });
    }
    const stateChange = path.match(/^\/tournaments\/18602864\/matches\/(\d+)\/change_state\.json$/);
    if (stateChange && init?.method === "PUT") {
      const match = state.matches.data.find((m) => m.id === stateChange[1]);
      if (!match) return Response.json({ errors: [{ detail: "Not found" }] }, { status: 404 });
      state.stateChanges.push({ matchId: stateChange[1], state: JSON.parse(String(init.body)).data.attributes.state });
      (match.attributes.timestamps as { underway_at: string | null }).underway_at = new Date().toISOString();
      state.etagVersion++;
      return Response.json({ data: match });
    }
    const put = path.match(/^\/tournaments\/18602864\/matches\/(\d+)\.json$/);
    if (put && init?.method === "PUT") {
      if (state.failPut) return Response.json({ errors: [{ detail: "Server error" }] }, { status: state.failPut });
      const match = state.matches.data.find((m) => m.id === put[1]);
      if (!match) return Response.json({ errors: [{ detail: "Not found" }] }, { status: 404 });
      const entries = JSON.parse(String(init.body)).data.attributes.match as Entry[];
      state.puts.push({ matchId: put[1], entries });
      if (!state.ignorePuts) {
        report(match, entries);
        state.etagVersion++;
      }
      return Response.json({ data: match });
    }
    return Response.json({ errors: [{ detail: `not stubbed: ${path}` }] }, { status: 404 });
  };

  return { state, fetch: fetchImpl, byIdentifier };
}
