// A small in-memory Challonge for a two-stage tournament, reproducing what spikes S17 and S19
// measured: matches carry neither a stage nor a group; rounds, identifiers and play order start
// again in each group and in the final stage; a round robin or Swiss group result changes that match
// only; a Swiss group gets its next round when its own round ends; a group that is a bracket moves
// its players on and stops when as many are left as advance, the match between them never opening;
// ending the group stage is refused while a match is open, and then rewrites the seeds and
// deactivates whoever doesn't advance; starting the final stage creates its matches; a group result
// is refused once the group stage has ended; finalizing ranks everyone.
// It starts from real tournaments recorded right after their group stage started: 6 players in 2
// round robin groups of 3, or 8 players in 2 groups of 4 (Swiss, single elimination or double
// elimination), 2 advancing from each group to a single elimination final stage.
// NOT from a spike: the pairing of a Swiss round and the placements, which are the simplest that fit
// (the leaders meet; the two finalists, the semifinal losers, then the rest), and a corrected winner
// in a bracket group, which wipes what followed as in a bracket that isn't a group (spike S4b).
import doubleFixture from "../fixtures/challonge/two-stage-double-elimination-tournament.json";
import roundRobinFixture from "../fixtures/challonge/two-stage-round-robin-tournament.json";
import singleFixture from "../fixtures/challonge/two-stage-single-elimination-tournament.json";
import swissFixture from "../fixtures/challonge/two-stage-swiss-tournament.json";

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
    points_by_participant: { participant_id: number | null; scores: number[] }[];
    winner_id: number | null;
    tie: boolean;
    timestamps: { created_at: string };
  };
};
type FakeParticipant = {
  id: string;
  type: "participant";
  attributes: { name: string; seed: number; final_rank: number | null; states: { active: boolean } };
};
type Groups = "round robin" | "swiss" | "single elimination" | "double elimination";
type Slot = [identifier: string, slot: 0 | 1];

const FIXTURES = { "round robin": roundRobinFixture, swiss: swissFixture, "single elimination": singleFixture, "double elimination": doubleFixture };
const GROUP_STAGE_OVER = "Cannot transition state via :submit_results_for_review from :complete (Reason(s): State translation missing: en.activerecord.errors.models.group_stage.attributes.state.invalid_transition)";
const GROUPS_NOT_DONE = "You must complete all group stage matches before finalizing the group stage";
// A Swiss group of 4 played 2 rounds in the spike.
const SWISS_ROUNDS = 2;
// Where the winner and the loser of a match of a 4-player bracket group go, and into which slot (spike S19).
const FEEDS: Partial<Record<Groups, Record<string, { winner?: Slot; loser?: Slot }>>> = {
  "single elimination": { A: { winner: ["C", 0] }, B: { winner: ["C", 1] } },
  "double elimination": {
    A: { winner: ["C", 0], loser: ["F", 0] },
    B: { winner: ["C", 1], loser: ["F", 1] },
    C: { winner: ["D", 0], loser: ["G", 0] },
    F: { winner: ["G", 1] },
    G: { winner: ["D", 1] },
  },
};
// The match between the two players a bracket group has left. Challonge never opens it (spike S19).
const DECIDER: Partial<Record<Groups, string>> = { "single elimination": "C", "double elimination": "D" };

export function createFakeTwoStage(groups: Groups) {
  const recorded = structuredClone(FIXTURES[groups]) as unknown as typeof roundRobinFixture;
  const included = recorded.included as unknown as (FakeMatch | FakeParticipant | { id: string; type: "user" })[];
  const options = recorded.data.attributes.group_stage_options;
  const state = {
    tournament: { data: recorded.data },
    matches: included.filter((r): r is FakeMatch => r.type === "match"),
    participants: included.filter((r): r is FakeParticipant => r.type === "participant"),
    etagVersion: 1,
    /** Answer 200 to a change of state without applying it. */
    ignoreStateChanges: false,
    /** Every request made, as "METHOD /path". */
    requests: [] as string[],
    tournamentStateChanges: [] as string[],
  };
  const id = recorded.data.id;
  const slug = recorded.data.attributes.url;
  const attributes = state.tournament.data.attributes as unknown as { state: string; timestamps: { started_at: string | null } };
  const etag = () => `W/"ts${state.etagVersion}"`;
  const playersOf = (m: FakeMatch) => m.attributes.points_by_participant.map((p) => (p.participant_id === null ? null : String(p.participant_id)));
  const feeds = FEEDS[groups] ?? {};
  const decider = DECIDER[groups];

  // Challonge fills the groups in seed order and creates a group's matches together, and tells
  // nobody which group anything is in; the fake has to remember.
  const groupOfPlayer = new Map(state.participants.map((p) => [p.id, Math.floor((p.attributes.seed - 1) / options.group_size)]));
  const groupOfMatch = new Map<string, number>();
  let lastGroup = 0;
  for (const m of [...state.matches].sort((a, b) => Number(a.id) - Number(b.id))) {
    const player = playersOf(m).find(Boolean);
    if (player) lastGroup = groupOfPlayer.get(player)!;
    groupOfMatch.set(m.id, lastGroup);
  }
  const groupCount = new Set(groupOfPlayer.values()).size;
  const finalMatches: FakeMatch[] = [];

  // A clock that moves five minutes with every write: an event takes time, and the app tells the
  // stages apart by when their matches were created.
  let clock = new Date(recorded.data.attributes.timestamps.created_at).getTime();
  const tick = () => new Date((clock += 5 * 60_000)).toISOString();
  let nextId = Math.max(...state.matches.map((m) => Number(m.id))) + 20;

  function newMatch(identifier: string, round: number, playOrder: number, players: [number | null, number | null]): FakeMatch {
    return {
      id: String(nextId++),
      type: "match",
      attributes: {
        identifier,
        round,
        state: players[0] && players[1] ? "open" : "pending",
        scores: "0 - 0",
        suggested_play_order: playOrder,
        score_in_sets: [],
        points_by_participant: players.map((participant_id) => ({ participant_id, scores: [] })),
        winner_id: null,
        tie: false,
        timestamps: { created_at: new Date(clock).toISOString() },
      },
    };
  }

  const groupMatches = (group: number) => state.matches.filter((m) => groupOfMatch.get(m.id) === group);
  const inGroup = (group: number, identifier: string) => groupMatches(group).find((m) => m.attributes.identifier === identifier)!;
  const winsIn = (list: FakeMatch[], participantId: string) => list.filter((m) => String(m.attributes.winner_id) === participantId).length;
  const seedOf = (participantId: string) => state.participants.find((p) => p.id === participantId)!.attributes.seed;
  /** A group's players, best first: by matches won, then by seed. In a bracket group, the two it has left come first. */
  function standing(group: number) {
    const members = [...groupOfPlayer].filter(([, g]) => g === group).map(([participantId]) => participantId);
    const left = decider ? playersOf(inGroup(group, decider)).filter((p): p is string => Boolean(p)) : [];
    const rest = members.filter((p) => !left.includes(p)).sort((a, b) => winsIn(groupMatches(group), b) - winsIn(groupMatches(group), a) || seedOf(a) - seedOf(b));
    return [...left, ...rest];
  }

  /** Pairs a Swiss group's next round once its last one is finished: the leaders meet, and so do the others. */
  function pairNextRound(group: number) {
    const played = groupMatches(group);
    const lastRound = Math.max(...played.map((m) => m.attributes.round));
    if (lastRound >= SWISS_ROUNDS || played.some((m) => m.attributes.state !== "complete")) return;
    const order = standing(group).map(Number);
    for (let i = 0; i + 1 < order.length; i += 2) {
      const number = played.length + i / 2;
      const match = newMatch(String.fromCharCode(65 + number), lastRound + 1, number + 1, [order[i], order[i + 1]]);
      state.matches.push(match);
      groupOfMatch.set(match.id, group);
    }
  }

  /** Takes a result back, and with it whatever its players went on to play. */
  function wipe(group: number, match: FakeMatch) {
    match.attributes.state = "open";
    match.attributes.winner_id = null;
    match.attributes.scores = "0 - 0";
    match.attributes.score_in_sets = [];
    const next = feeds[match.attributes.identifier] ?? {};
    for (const target of [next.winner, next.loser]) {
      if (!target) continue;
      const later = inGroup(group, target[0]);
      if (later.attributes.state === "complete") wipe(group, later);
      later.attributes.points_by_participant[target[1]].participant_id = null;
      later.attributes.state = "pending";
    }
  }

  /** Moves the winner and the loser of a bracket group's match on. The match between the last two stays closed. */
  function moveOn(group: number, match: FakeMatch, winner: number, loser: number) {
    const next = feeds[match.attributes.identifier] ?? {};
    for (const [player, target] of [[winner, next.winner], [loser, next.loser]] as const) {
      if (!target) continue;
      const later = inGroup(group, target[0]);
      // A corrected winner sends someone else on: what the first one played there is gone.
      if (later.attributes.state === "complete") wipe(group, later);
      later.attributes.points_by_participant[target[1]].participant_id = player;
      const full = later.attributes.points_by_participant.every((p) => p.participant_id);
      later.attributes.state = full && target[0] !== decider ? "open" : "pending";
    }
  }

  /** Ends the group stage: the seeds become the order of advancing, and the others are deactivated. */
  function finalizeGroupStage() {
    const advance = options.participant_count_to_advance_per_group;
    const standings = Array.from({ length: groupCount }, (_, group) => standing(group));
    const places = Math.max(...standings.map((s) => s.length));
    // Every group's first place, then every second place, and so on.
    const order = Array.from({ length: places }, (_, place) => standings.map((s) => ({ participantId: s[place], place }))).flat().filter((p) => p.participantId);
    order.forEach(({ participantId, place }, index) => {
      const participant = state.participants.find((p) => p.id === participantId)!;
      participant.attributes.seed = index + 1;
      participant.attributes.states.active = place < advance;
    });
    attributes.state = "group_stages_finalized";
  }

  /** Starts the final stage: a single elimination bracket of the four who advanced. */
  function startFinalStage() {
    const seeded = state.participants.filter((p) => p.attributes.states.active).sort((a, b) => a.attributes.seed - b.attributes.seed).map((p) => Number(p.id));
    if (seeded.length !== 4) throw new Error(`The fake's final stage is a bracket of 4, not ${seeded.length}.`);
    attributes.timestamps.started_at = tick();
    finalMatches.push(newMatch("A", 1, 1, [seeded[0], seeded[3]]), newMatch("B", 1, 2, [seeded[1], seeded[2]]), newMatch("C", 2, 3, [null, null]));
    state.matches.push(...finalMatches);
    attributes.state = "underway";
  }

  function finalize() {
    const [semi1, semi2, final] = finalMatches;
    const loserOf = (m: FakeMatch) => playersOf(m).find((p) => p !== String(m.attributes.winner_id))!;
    const ranks = new Map([[String(final.attributes.winner_id), 1], [loserOf(final), 2], [loserOf(semi1), 3], [loserOf(semi2), 3]]);
    for (const p of state.participants) p.attributes.final_rank = ranks.get(p.id) ?? 5;
    attributes.state = "complete";
  }

  function report(match: FakeMatch, entries: Entry[]) {
    const previousWinner = match.attributes.winner_id;
    const [a, b] = match.attributes.points_by_participant;
    const scoresOf = (participantId: number | null) => entries.find((e) => e.participant_id === String(participantId))!.score_set.split(",").map(Number);
    [a.scores, b.scores] = [scoresOf(a.participant_id), scoresOf(b.participant_id)];
    match.attributes.score_in_sets = a.scores.map((s, i) => [s, b.scores[i]]);
    match.attributes.scores = `${a.scores[0]} - ${b.scores[0]}`;
    match.attributes.winner_id = Number(entries.find((e) => e.rank === 1)!.participant_id);
    match.attributes.state = "complete";

    const group = groupOfMatch.get(match.id);
    if (group !== undefined && groups === "swiss") pairNextRound(group);
    // The same result sent again moves nobody.
    if (group !== undefined && decider && previousWinner !== match.attributes.winner_id) {
      moveOn(group, match, match.attributes.winner_id, Number(entries.find((e) => e.rank !== 1)!.participant_id));
    }
    // The winner of a semifinal goes to the final.
    const semi = finalMatches.indexOf(match);
    if (semi === 0 || semi === 1) {
      const final = finalMatches[2];
      final.attributes.points_by_participant[semi].participant_id = match.attributes.winner_id;
      if (final.attributes.points_by_participant.every((p) => p.participant_id)) final.attributes.state = "open";
    }
  }

  const refuse = (detail: string) => Response.json({ errors: [{ detail, status: 422 }] }, { status: 422 });

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
      if (state.ignoreStateChanges) return Response.json({ data: state.tournament.data });
      const open = state.matches.some((m) => m.attributes.state === "open");
      if (requested === "finalize_group_stage") {
        if (attributes.state !== "group_stages_underway") return refuse(`Cannot transition state via :finalize_group_stage from :${attributes.state}`);
        if (open) return refuse(GROUPS_NOT_DONE);
        tick();
        finalizeGroupStage();
      } else if (requested === "start") {
        if (attributes.state !== "group_stages_finalized") return refuse(`Cannot transition state via :start from :${attributes.state}`);
        startFinalStage();
      } else if (requested === "finalize") {
        if (attributes.state !== "underway" || open) return refuse("Tournament still has matches to play");
        tick();
        finalize();
      }
      state.etagVersion++;
      return Response.json({ data: state.tournament.data });
    }
    const put = path.match(new RegExp(`^/tournaments/${id}/matches/(\\d+)\\.json$`));
    if (put && method === "PUT") {
      const match = state.matches.find((m) => m.id === put[1]);
      if (!match) return Response.json({ errors: [{ detail: "Not found" }] }, { status: 404 });
      if (groupOfMatch.has(match.id) && attributes.state !== "group_stages_underway") return refuse(GROUP_STAGE_OVER);
      tick();
      report(match, JSON.parse(String(init!.body)).data.attributes.match as Entry[]);
      state.etagVersion++;
      return Response.json({ data: match });
    }
    return Response.json({ errors: [{ detail: `not stubbed: ${path}` }] }, { status: 404 });
  };

  return { state, fetch: fetchImpl, id, slug };
}
