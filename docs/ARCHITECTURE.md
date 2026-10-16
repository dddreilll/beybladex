# BXQ architecture

How BXQ is built today. Why it is built this way (the decisions, the Challonge API spikes, and the record of each milestone) is in [rfc-001-architecture.md](rfc-001-architecture.md). What it is for is in [PRD.md](PRD.md). Setup, scripts and deployment are in the [README](../README.md).

## At a glance

```
┌──────────────────────────── Devices at the venue ─────────────────────────────┐
│ BXQ Desk          BXQ Pad               BXQ Board          BXQ Pass           │
│ organizer         judge tablet          TV                 player phone       │
│ session           stadium cookie        screen cookie      player cookie      │
│     │                 │ IndexedDB           ▲                  ▲              │
│     │                 │ outbox              │                  │ web push     │
└─────┼─────────────────┼─────────────────────┼──────────────────┼──────────────┘
      │ HTTPS           │ sync when online    │ poll + Realtime  │ poll (10 s)
┌─────▼─────────────────▼─────────────────────┴──────────────────┴──────────────┐
│ Next.js server                                                                │
│   auth and access · scoring engine · stadium queue · web push                 │
│                         │                                                     │
│                 ┌───────▼────────┐  a trigger on board_version                │
│                 │ Postgres       │──────────────► Supabase Realtime           │
│                 │ (schema "app") │  ("board changed", no data)                │
│                 └───────┬────────┘                                            │
│   Challonge sync layer: metered client · token refresh · import and resync ·  │
│   report · finalize                                                           │
└─────────────────────────┬─────────────────────────────────────────────────────┘
                          ▼
            api.challonge.com/v2.1 (the organizer's own OAuth app)
```

Two rules shape everything else.

1. **Only the server talks to Challonge.** No browser ever does. Every screen reads BXQ's own endpoints, so live updates cost no Challonge requests.
2. **Postgres holds the live state of the floor.** Challonge holds the bracket. A finished match is written through to Challonge, and the bracket is re-read only after BXQ's own writes or when the organizer presses Resync.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| UI | Tailwind CSS 3 with shadcn/ui (Radix), Lucide icons. See [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md). |
| Auth | Supabase Auth, magic links, invite-only |
| Database | Supabase Postgres through Drizzle ORM and `postgres`. Tables are in a private `app` schema. |
| Live updates | Polling BXQ's own endpoints with an ETag, plus Supabase Realtime as a hint |
| Offline | A hand-written service worker (`public/sw.js`) and an IndexedDB outbox (`lib/offline/`) |
| Push | `web-push` with VAPID keys |
| Validation | Zod |
| Tests | Vitest (unit and database integration), Playwright driving the installed Edge or Chrome (end to end) |

Next.js 16 names its request interceptor `proxy.ts`, not `middleware.ts`. It refreshes the organizer's Supabase session and skips `/api/public/`, which devices poll every few seconds. `cacheComponents` is off, because every page reads per-organizer data.

## Data model

All tables are in the `app` schema (`lib/db/schema.ts`). Supabase's Data API doesn't expose that schema, row-level security is on, and the API roles are revoked, so every read and write goes through the server.

| Table | Holds |
|---|---|
| `challonge_connections` | One Challonge OAuth app per organizer: the client ID, and the client secret and tokens as encrypted envelopes |
| `api_usage` | BXQ's own count of Challonge requests per connection per month |
| `rule_profiles` | An organizer's own scoring rules. The presets are in code (`lib/scoring/profile.ts`). |
| `tournaments` | The imported tournament, its format (`tournament_type`, `group_stage`, `group_stage_type`, `group_size`, `started_at`, `swiss_rounds`), its rules, the matches ETag, `public_slug`, `short_code`, `board_version`, and the venue switches |
| `participants` | Players, with `passcode`, `sign_in_token`, `advanced` once a group stage has ended and, once final, `final_rank` |
| `matches` | Challonge's fields, the `stage` and `group_number` worked out for a two-stage tournament, plus the local queue state: `stadium_id`, `call_status`, `call_count`, `held`, `rule_snapshot`, and the learned next-match links |
| `stadiums` | The stadiums of a tournament, in order |
| `battles` | Every tap on a pad. Undo voids a battle and never deletes it. `op_id` is unique. |
| `sync_outbox` | Results on their way to Challonge, for retries and as a record of who reported what |
| `push_subscriptions` | A player's browser push subscription |
| `board_screens` | Screens that asked to show the board, whether they are approved, and when each was last seen or said it closed (`closed_at`) |
| `judge_screens` | Who judges each stadium: an approved tablet, or the organizer; last seen and `closed_at` as for a board |
| `player_sessions` | The one device each player is signed in on; last seen and `closed_at` as for a board |
| `sign_in_failures` | Wrong passcode attempts, kept for up to an hour to slow down guessing: one row for the network, one for the player, and one for the player on the device that made it |

Migrations are SQL files in `drizzle/`, generated from the schema with `npm run db:generate`.

## The Challonge sync layer

Everything that calls Challonge is in `lib/challonge/` and runs on the server.

| Module | Job |
|---|---|
| `client.ts` | The HTTP client. Sends `If-None-Match` when it has an ETag, follows `links.next`, and reports every request to the meter, 304 answers included. |
| `connection.ts`, `oauth.ts` | Saving credentials, the authorization-code flow, and token refresh. Challonge rotates the refresh token, so a refresh runs under a row lock and saves both tokens together. |
| `sync.ts` | Review, import and Resync |
| `support.ts` | Which formats BXQ runs, and what the organizer reviews before an import |
| `import-review.ts` | The signed token that carries a reviewed tournament from Review to Import |
| `report.ts` | Sending a result or a correction |
| `progression.ts` | Learning which match the winner and the loser move on to. Challonge doesn't expose those links. |
| `finalize.ts` | Finalizing and reading the standings |
| `stages.ts` | Working out the stage and the group of each match of a two-stage tournament. Challonge gives neither. |
| `stage-change.ts` | Ending the group stage and starting the final stage |
| `budget.ts` | The request counter behind the budget meter |

### What each action costs

| Action | Requests | How |
|---|---|---|
| List the organizer's Challonge tournaments (optional) | 1 | Only when the organizer asks for the list on the Tournaments page |
| Import | 3 | The tournament, its participants, its matches. By link or ID the first request is the review; the other two follow when the organizer confirms. |
| A review, import or resync refused for the format | 1 | The tournament is read and found to be a format BXQ doesn't run. Nothing else is asked. |
| Resync, nothing changed | 2, or 3 in Swiss and in a two-stage tournament | The tournament, then the matches with `If-None-Match`, answered 304. Participants are read again only if their count changed; in Swiss always, because a player who drops out stays in the count, and in a two-stage tournament always, because the end of the group stage changes seeds and not the count. |
| Send a result | 2 in a bracket and in a group that is one; 1 in a round robin, in Swiss and in a round robin or Swiss group | The score update. In a bracket, then one refresh of the matches, because the result moved players on. |
| Read the next Swiss round | 1, or 2 if it is late | After the last result of a round, the matches are read once the round has had a second to be paired, and again two seconds later if it isn't there. A Swiss group has its own rounds and no count of them, so both reads follow its last round too. |
| End the group stage | 2 | The change of state, then the participants, whose seeds and `active` Challonge has rewritten |
| Start the final stage | 2 | The change of state, then the matches Challonge created |
| Mark underway (optional) | 1 | Per match |
| Finalize | about 4, or 5 in Swiss and in a two-stage tournament | A resync, the finalize call, then the participants with their final rank |

### Supported formats and the import review

BXQ runs single elimination, double elimination, round robin and Swiss, and a two-stage tournament whose groups are any of those four and whose final stage is a bracket. `formatSupport` in `support.ts` refuses free for all (its matches have more than two players) and any other two-stage tournament. It is asked wherever a tournament is read from Challonge: for each row of the organizer's Challonge tournaments, in a review, in an import and in a resync.

An import asks first, in a dialog.

- **By link or ID,** `reviewTournament` reads the tournament (1 request). It returns what the dialog shows and a token: the fields an import stores, signed with `signPayload`, tied to the organizer and valid for 10 minutes. `importReviewed` checks the token and reads only the participants and the matches. The import still costs 3 requests, and a browser can't swap in a format that was refused.
- **From the list,** the details are already on the page, so the dialog opens without a request. Confirming runs `importTournament`, which reads the tournament again and checks its format.

A resync that finds an unsupported format stops after its first request. It records `tournament_type`, `group_stage` and `group_stage_type`, so the Desk can show why, and leaves the stored bracket alone. Finalize resyncs first, so it is refused the same way.

### Brackets, round robin and Swiss

In a bracket a result moves its players into later matches, and a corrected winner can erase them. In a round robin every match exists from the start, and in Swiss a round's matches all exist once it is paired; in both a result changes that match only. `isElimination` and `isSwiss` in `support.ts` are where the app asks which it has.

| | Bracket | Round robin | Swiss |
|---|---|---|---|
| After a result | The matches are read again (1 more request) | The match is updated from Challonge's answer; nothing is read | As round robin, except after the last result of a round |
| A corrected winner | BXQ asks first if completed matches would be erased | Nothing is asked: nothing is erased | Nothing is asked; later rounds keep their pairings |
| Round labels | Winners and losers rounds, finals, consolation matches | "Round N"; the last round is not a final | "Round N" |
| Finals rules of a profile | Apply to the last round | Not used | Not used |
| Resync | Participants read only if their count changed | The same | Participants always read |

Because a round robin or a Swiss round isn't read again after a result, something changed on challonge.com during the event reaches BXQ with the next Resync. A match can be complete without a winner there: a tie, which the pad never sends and the screens show as one.

**The next Swiss round.** Challonge pairs it after it has answered the round's last result: 35 to 300 ms later in every measurement, and once later than a read sent straight away (spikes S8, S10 in the RFC). So `readNextRound` in `report.ts` waits a second before reading the matches, and reads once more two seconds later if no new round is in them (`pairingWait`). If the round still isn't there, the pad is told and the Desk says which round it is waiting for. `tournaments.swiss_rounds` holds how many rounds there are, so nothing is read after the last one, and `finalizeBlockers` doesn't offer Finalize between rounds, when nothing is open but rounds remain.

**A player who drops out** is deactivated on Challonge without leaving its participant count, and their open match is completed as a forfeit (spike S8). BXQ learns of both at the next Resync, which is why a Swiss resync always reads the participants.

### Two-stage tournaments

A two-stage tournament has a group stage and a final stage. Challonge's `tournament_type` is the format of the final stage; the format of the groups is in `group_stage_options.stage_type`. Everything above still applies, to each match in the format of its own stage: `stageType` in `support.ts` gives it, and `report.ts`, `rules.ts` and the round labels ask it.

**Which stage, which group.** Challonge doesn't say: a match has no group, a participant's `group_id` stays null, and rounds, identifiers and play order start again in every group and in the final stage (spike S17 in the RFC). `stages.ts` works both out whenever matches are stored, and they are kept in `matches.stage` and `matches.group_number`.

- **The stage** is `group` until the final stage starts. After that, a match is a group match if it was created more than 2 seconds before `tournaments.started_at`, which Challonge sets when the final stage starts. The request that starts the final stage creates its matches, a few milliseconds before that time.
- **The group** comes from the order of the match ids. Challonge creates a group's matches together, the first of them "A". A later match, such as a Swiss round, belongs to the group of its players. If a match joins two groups, or a group ends up with more players than `group_size`, no match gets a group and the labels say "Group stage". The same when there is one group.

**Round labels** come from `roundLabeller` in `map.ts`, which gives each stage its own rounds: "Group A · Round 2" in the groups, and the bracket's labels in the final stage. The finals rules of a profile apply to the last round of the final stage only. In the queue the groups take turns, since every group has a match with play order 1.

**Groups that are brackets** need nothing of their own. A result is read back like any bracket result, the links to the next matches are learned within the group, and a corrected winner asks first. Such a group is played until as many players are left as advance: the match between them (the group's final, or its grand final) gets its players and stays `pending`, and Challonge ends the group stage without it (spike S19 in the RFC). Since only open matches are queued, counted as still to play or shown as waiting, that match appears nowhere.

**Swiss groups** each have their own rounds. Challonge pairs a group's next round when that group's round ends, whatever the other groups are doing, so `readNextRound` looks at the rounds of the match's group. It has no count of them: after a group's last round both reads find nothing, and nothing is said.

**Between the stages** there are two steps, as on Challonge, in `stage-change.ts`.

1. `endGroupStage` asks for `finalize_group_stage`, then reads the participants. Challonge has rewritten their seeds into the order they advance in, and set `active` to false for everyone who doesn't advance. BXQ keeps that as `participants.advanced` and leaves its own `active` alone from then on, so those players stay on the Pass sign-in list. It is refused here, without a request, while a group match is open or a result is unsent; Challonge refuses it too, and its reason is passed on.
2. `startFinalStage` asks for `start`, stores `started_at`, then reads the matches.

Once the group stage has ended Challonge refuses a group result, so `submitResult` refuses a correction of one without sending it. Finalize isn't offered, and isn't sent, before the final stage. A Pass says "You're through to the final stage" or "You didn't advance" (`playerStatus`).

**A final stage that is a round robin or Swiss** is run like a tournament of that format, from its own matches: a result is 1 request, no match gets the finals rules, and a Swiss final stage's next round is read after the last result of a round, with `swiss_rounds` saying when to stop. Its rounds start again at 1, so `readNextRound` asks the stored matches of the final stage, not Challonge's whole list, whether the next round has come (the groups' later rounds have the same players), and `finalizeBlockers` counts the final stage's rounds alone. `formatSupport` still refuses these tournaments until spike S20 has played one against the real Challonge; `BXQ_UNVERIFIED_FINAL_STAGES=1` accepts them, for the tests and for that run.

### Standings

`lib/standings.ts` works out running standings from the stored matches, with no request: for a round robin and Swiss, for every group of a two-stage tournament (whatever the group's format), and for a round robin or Swiss final stage. Not for a bracket without groups. A complete match counts a win and a loss, or a tie for both when it has no winner. Players are ranked by wins, a tie counting half, then by fewer losses; the same wins and losses share a place. Challonge's own tie-breaks aren't copied, so every screen that shows them says they aren't official. Each table says whether its stage is the one being played: the Desk shows every table, the board only those (`BoardSnapshot.tables`, once a match of them has a result, the best 10 rows). The Pass gets none.

### A 200 is not trusted

Challonge can answer 200 and ignore the change (it does for a tie in an elimination match). After every score update, `report.ts` checks that the match is `complete` with the expected winner. Finalizing checks that the tournament is `complete`, and each step between the stages of a two-stage tournament checks the state it asked for. A send that fails stays in `sync_outbox` and the Desk offers Retry.

### Corrections

A correction is one direct update; BXQ never reopens a match. Challonge resets later matches without warning, so before sending, BXQ walks the next-match links it has learned and asks the organizer to confirm any result that would be erased. Afterwards the battles of every wiped match are voided, not deleted. In a round robin a correction resets nothing, so BXQ sends it without asking.

## The queue and the calls

`lib/queue.ts` is a pure planner. It gives each active stadium one current match and one on-deck match, in Challonge's suggested play order, and skips held matches and players who are already busy. `reconcileQueue` in `lib/venue.ts` runs it under a row lock on the tournament after every result, import, resync, stadium change and organizer action.

A match moves through `call_status`: `none`, `on_deck`, `called`, `playing`. A called match can start only if its stadium has a judge. An on-deck match can be moved to another stadium whose on-deck slot is empty (`moveOnDeck`); its `notified_status` is cleared, so its players are told the new stadium, and the queue is planned again.

Every change a screen should show bumps `tournaments.board_version`.

## Live updates

No screen calls Challonge. Each one polls an endpoint on BXQ's server and sends the version it already has as a weak ETag (`W/"v<board_version>"`). An unchanged version is answered 304 after one indexed lookup. Polling pauses while the tab is hidden.

A database trigger on `board_version` sends a "changed" message on the public Realtime channel `board:<slug>`. A screen that listens checks at once when the message arrives, and slows its own polling to once every 60 seconds while the channel is connected. The message carries no data, so a forged one can only cause an extra check.

| Screen | Endpoint | Realtime | Poll without Realtime | Poll with Realtime |
|---|---|---|---|---|
| BXQ Desk | `/api/tournaments/<id>/version` | Yes | 4 s | 60 s |
| BXQ Board | `/api/public/<slug>/board` | Yes | 2.5 s | 60 s |
| Judge tablet, between matches | `/api/public/<slug>/judge` | Yes | 3 s | 60 s |
| BXQ Pass | `/api/public/<slug>/me` | No | 10 s | not used |

Player phones stay on polling to keep within Supabase's Realtime connection cap. The call itself reaches them by web push. The shared code is `components/board/use-board.ts` and `board-signal.ts`.

A check counts as the screen being open, and the Desk shows a board, a judge tablet or a Pass as open for 150 seconds after its last one (`SCREEN_OPEN_MS`). As its tab closes, a screen also sends a beacon to `<endpoint>/bye` (`useCloseSignal`), which sets `closed_at`, and the Desk shows it closed on its next look at the access panel, within 8 seconds. The next check clears `closed_at`, so a reload or a page brought back from the browser's cache is open again. A beacon that never arrives (offline, a device that dies) leaves the 150 seconds.

## Scoring

`lib/scoring/engine.ts` is pure TypeScript, shared by the pad and the server. It turns a list of battles and a rule profile into the score, the sets and the winner. `describe.ts` turns the same data into text ("Latest battle: Alex · Xtreme +3") and into the battle-by-battle sheet.

A match freezes its rules in `matches.rule_snapshot` when scoring starts, so editing a profile can't change a match in progress.

A pad sends operations: `add`, `void` and `start`. Each has a client-made `op_id` with a unique constraint, so sending one twice is harmless.

## Offline on the pad

| Part | Where | What it does |
|---|---|---|
| Outbox | `lib/offline/outbox.ts`, in IndexedDB through `idb-storage.ts` | Per match: the battles the server last confirmed, the operations not yet confirmed, and optionally an intent to send the result. A tap applies at once and survives a reload or a crash. |
| Sync loop | `components/offline/outbox-sync.tsx` | One per device. It flushes every match's outbox on reconnect, on tab focus, and every 5 seconds while work is pending. |
| Endpoints | `POST /api/matches/<id>/battles`, `POST /api/matches/<id>/result` | Plain route handlers, not server actions. A server action's ID changes on every build, so a pad restored from the offline cache after a deploy could never sync. |
| Service worker | `public/sw.js` | Caches pad pages and `/_next/static`, always network-first, with a fallback to the cache after 5 seconds on a stalled connection. The Desk pre-loads the pads of matches at stadiums. |

The outbox takes its storage and its transport by injection, so it is unit-tested without a browser. Syncing needs BXQ open in a tab: the Background Sync API isn't used, because Safari doesn't support it.

A result finished offline is stored as an intent and sent once the queued taps are confirmed. A refusal (a correction that needs confirmation, Challonge not connected, a conflict) is shown as a problem and not retried in a loop.

## Web push

A player opts in on their Pass. The browser subscribes through the service worker, and `POST /api/public/<slug>/push` stores the subscription against the signed-in player.

- **Sent exactly once.** `matches.notified_status` records what players were last told. `dispatchNotifications` in `lib/push.ts` claims every match where it differs from `call_status` in one `UPDATE … RETURNING`, so concurrent callers can't send twice.
- **Sent after the response,** through Next's `after()`, so a push never slows an organizer's click.
- **Only real push services are accepted** (`lib/push-endpoint.ts`): the server later posts to the stored address, so an open list would let anyone make it call arbitrary addresses.
- **Optional.** Without the VAPID keys the button is hidden and nothing is sent.

## Security and access

| Who | How they get in | What they can reach |
|---|---|---|
| Organizer | A Supabase magic link. Sign-ups are off; `npm run invite` grants access. | Their own tournaments, rules and Challonge connection |
| Board | Opens the board link, shows a pairing code, and the organizer approves it on the Desk. Limited per tournament. | The board data of that tournament |
| Judge tablet | Opens the judge link, picks a stadium, and the organizer approves it. One judge per stadium, enforced by a partial unique index. | The current and on-deck match of its stadium; it can score the current one |
| Player | A 4-digit passcode, or the QR code on their slip. One device at a time. | Their own matches, placement and battle scores |

- **Challonge secrets** are stored as AES-256-GCM envelopes (`lib/crypto/secrets.ts`). The keys come from `APP_ENCRYPTION_KEYS` and are versioned, so a key is rotated by adding a new one in front. The secrets never reach the browser. The OAuth `state` is signed and carries the organizer's ID.
- **Device sessions** are httpOnly cookies, one per tournament. Only a SHA-256 hash of each is stored.
- **Endpoints that act on a cookie refuse cross-site requests** (`lib/api-auth.ts`).
- **The QR secret is after the `#`** of the address, which browsers never send to a server. A link preview or a scanner that fetches the address can't sign in.
- **Wrong passcodes are limited:** 10 per player on one device per 10 minutes, 60 per player across every device per hour, and 30 per network per 5 minutes. The device is a random `bxq_device` cookie, stored hashed in the failure's bucket. So somebody else's guesses lock their own device, not the player's phone, and a guesser who clears the cookie still takes days to sweep a passcode. While a lock lasts even the right passcode is refused; the QR code isn't.
- **Public links are unguessable or need approval.** The slug in `/t/<slug>` is 16 random hex characters. The short links `/b/<code>` and `/j/<code>` lead only to screens the organizer still has to approve.

## Repository structure

```
app/
  page.tsx                     landing page; terms/ and privacy/ are the legal pages
  auth/                        magic-link sign-in, the confirm route, the error page
  (organizer)/                 signed-in pages with the shared header and side navigation
    tournaments/               list and import
    rules/                     rule profiles
    settings/challonge/        the organizer's Challonge app: credentials, connect, remove
  (control)/tournaments/[id]/  BXQ Desk; passcodes/ prints the slips
  (judge)/tournaments/[id]/matches/[matchId]/   the organizer's own BXQ Pad
  t/[slug]/                    BXQ Pass; board/ is BXQ Board, judge/ a judge tablet's BXQ Pad
  b/[code]/ · j/[code]/        short links to the board and the pad sign-up
  api/
    challonge/oauth/callback/  the OAuth redirect
    matches/[matchId]/         battles and result: the pad's endpoints
    tournaments/[id]/          version and access: polled by the Desk
    public/[slug]/             board, judge, me, push, session: polled by venue devices; */bye as their tabs close
components/
  ui/                          shadcn/ui components
  board/                       the board, the Pass, and the polling hooks
  judge/                       the pad, the tablet's waiting screen, pairing
  offline/                     the outbox sync loop
  landing/ · legal/            the landing page and the legal pages
lib/
  challonge/                   the API client, OAuth, token refresh, sync, report, finalize, budget
  scoring/                     rule profiles and presets, the scoring engine, battle descriptions
  offline/                     the pad's outbox, its IndexedDB storage and its transport
  db/                          the Drizzle schema and client
  crypto/secrets.ts            AES-256-GCM envelopes and signed OAuth state
  queue.ts · venue.ts          the queue planner, and the actions that run it
  access.ts · judges.ts        access for boards and players; judge tablets
  battles.ts · pad.ts          pad operations, and who may use a pad
  board.ts · player-status.ts  what a board and a player are sent
  push.ts · push-endpoint.ts   sending web push; which endpoints are accepted
  control-room.ts              the Desk's queue builder (pure)
  standings.ts                 running standings by record (pure)
  config.ts                    APP_NAME, APP_TAGLINE, limits, environment helpers
drizzle/                       SQL migrations
public/sw.js                   the service worker: push and offline pads
proxy.ts                       session refresh for organizer pages
scripts/                       invite an organizer; migrate on deploy
supabase/                      local Supabase config and the invite email template
tests/                         unit, integration and end-to-end tests; Challonge fixtures
spikes/                        the throwaway API spike scripts behind the RFC
docs/                          this document, PRD, design system, brand guide, RFC
```

Comments, identifiers and file names keep the names they were written with (`control-room.ts`, `call-board.tsx`, `JudgePad`). The screens they belong to are listed in [brand.md](brand.md).

## Testing

| Kind | Where | What it covers |
|---|---|---|
| Unit | `tests/*.test.ts`, `tests/scoring/`, `tests/challonge/`, `tests/offline/`, `tests/crypto/` | The scoring engine, the queue planner, the Challonge client and mapping against recorded responses, the outbox, encryption |
| Integration | `tests/integration/` | Sync, reporting, the queue, access, judges, push and finalize, against local Supabase and a fake Challonge: one for a double elimination bracket, one for a round robin, one for a Swiss tournament and one for a two-stage tournament (every kind of group, and a final stage that is a bracket, a round robin or Swiss). They run with `npm test` when `.env.local` points at a database. |
| End to end | `tests/e2e/*.e2e.mjs` | Ten suites in a real browser: the offline pad, the Desk, a two-stage tournament with its standings, navigation, access, battle scores, judge tablets, themes, the landing page, sign-in |

The fake Challonge follows the documentation and the recorded fixtures in `tests/fixtures/challonge/`. No test calls the real API, so the tests cost no requests.
