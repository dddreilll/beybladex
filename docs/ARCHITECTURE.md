# BXQ architecture

How BXQ is built today. Why it runs its own brackets, and the record of that change, is in [rfc-002-own-bracket-engine.md](rfc-002-own-bracket-engine.md); how it was first built on Challonge is kept in [rfc-001-architecture.md](rfc-001-architecture.md). What it is for is in [PRD.md](PRD.md). Setup, scripts and deployment are in the [README](../README.md).

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
│   auth and access · bracket engine · scoring engine · stadium queue · push    │
│                         │                                                     │
│                 ┌───────▼────────┐  a trigger on board_version                │
│                 │ Postgres       │──────────────► Supabase Realtime           │
│                 │ (schema "app") │  ("board changed", no data)                │
│                 └────────────────┘                                            │
└───────────────────────────────────────────────────────────────────────────────┘
```

Two rules shape everything else.

1. **The server decides.** A result is recorded on the server, in one transaction: the bracket moves on, the next Swiss round is paired, the queue is planned again. A device shows what the server says and never works out a bracket itself.
2. **Postgres holds everything.** The bracket, the queue, the calls and every battle are in BXQ's own database. No outside service is called during an event, so nothing limits how often a screen checks.

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
| `rule_profiles` | An organizer's own scoring rules. The presets are in code (`lib/scoring/profile.ts`). |
| `tournaments` | The name, the `state` (below), the format (`tournament_type`; with `group_stage`, also `group_stage_type`, `group_count` and `advance_per_group`), the options of the format (`grand_final`, `third_place`, `round_robin_legs`, `swiss_rounds`), `started_at`, its rules, `public_slug`, `short_code`, `board_version`, and the venue switches |
| `participants` | Players, in `seed` order, with `active` (false once dropped), `passcode`, `sign_in_token`, and `final_rank` once the tournament is finished. In a two-stage tournament also `group_number`, `advanced` once the group stage has ended, and `final_seed`. |
| `matches` | The engine's match (below): `key`, `number` (below), `round`, `play_order`, `stage`, `group_number`, `state`, the players and the winner, `scores`, `section`, `third_place`, `if_needed`, `bye`, `forfeit`, and the `winner_to` and `loser_to` links. Plus the local queue state: `stadium_id`, `call_status`, `call_count`, `held`, `notified_status` and `rule_snapshot`. |
| `stadiums` | The stadiums of a tournament, in order |
| `battles` | Every tap on a pad. Undo voids a battle and never deletes it. `op_id` is unique. |
| `push_subscriptions` | A player's browser push subscription |
| `board_screens` | Screens that asked to show the board, whether they are approved, and when each was last seen or said it closed (`closed_at`) |
| `judge_screens` | Who judges each stadium: an approved tablet, or the organizer; last seen and `closed_at` as for a board |
| `player_sessions` | The one device each player is signed in on; last seen and `closed_at` as for a board |
| `sign_in_failures` | Wrong passcode attempts, kept for up to an hour to slow down guessing: one row for the network, one for the player, and one for the player on the device that made it |

Migrations are SQL files in `drizzle/`, generated from the schema with `npm run db:generate`. Migration 0016 deleted every tournament imported from Challonge, and 0017 dropped the Challonge tables and columns (RFC-002). 0020 numbered the matches across each tournament and 0021 dropped their letters.

## The bracket engine

`lib/bracket/` builds and runs brackets. It is pure: players in, matches out. It never touches the database, so it is unit-tested on its own (`tests/bracket/`).

| Module | Job |
|---|---|
| `types.ts` | `BracketMatch`, `SlotRef`, `Format`, how an error names a match, and the checks on a list of players |
| `single-elimination.ts` | The bracket for the next power of 2, seeded so seeds 1 and 2 can meet only in the final (`seedOrder`: 1, 8, 4, 5, 2, 7, 3, 6). A bye is not a match: the player facing it starts in round 2. An optional third-place match. |
| `double-elimination.ts` | The full winners and losers brackets for the next power of 2, then the byes taken out, so n players play 2n − 2 matches, plus the reset if it is needed. Losers drop into the losers bracket crossed over, to put off rematches. The grand final can reset, or be single. |
| `round-robin.ts` | The circle method, one or two legs (the second with the sides swapped). With an odd number of players, one sits out each round. |
| `swiss.ts` | Round 1 top half against bottom half; after that, players on the same wins are paired top half against bottom half, with a search that avoids rematches and allows them only when nothing else works. With an odd count, the lowest-ranked player without a bye has one, which is a win. `suggestedSwissRounds` gives enough rounds to leave one player unbeaten. |
| `standings.ts` | Standings of a round robin or Swiss: wins, then Buchholz (the wins of every opponent met), then head-to-head, then Beyblade X points difference, then seed. `placements` gives the final places of any format: in a bracket, players knocked out in the same round share a place, except where a third-place match separates them. |
| `two-stage.ts` | Groups by snake seeding (`splitIntoGroups`), each group's ranking once played out (`rankGroup`), and the final stage's seeds (`seedFinalStage`): every group winner, then every runner-up, swapped within a tier so that nobody meets a player from their own group in the first round where it can be avoided. |
| `progress.ts` | `recordWinner` moves the winner along `winner_to` and the loser along `loser_to`. `correctWinner` changes a winner and returns the later matches whose results it erases. `openMatches`, `champion`. |

Each match has a `key` that is stable within its bracket ("R2-1", "L3-2", "GF1", "3P"), and links to the slots its winner and loser go to. A match with both players and no winner is `open`; with a winner, `complete`; otherwise `pending`. A grand-final reset (`if_needed`) only gets its players if the losers-bracket player wins the first grand final, so it never opens otherwise.

## Running a tournament

`lib/tournament/` connects the engine to the database and to the Desk.

| Module | Job |
|---|---|
| `format.ts` | Formats and their names, the tournament states, `stageType` (the format of the group stage or the final stage) |
| `setup.ts` | Parsing names typed or pasted ("Alex, Sam" on one line is two players), and what must be true before a start (pure) |
| `create.ts` | `createTournament` and `startTournament` |
| `players.ts` | Before the start: add, remove, rename, move a seed, shuffle. After it: drop a player, add a late player to a Swiss, rename. Deleting a tournament. |
| `build.ts` | The matches a stage starts with, and whether a Swiss round is due (pure) |
| `store.ts` | Engine matches to rows and back, match numbers (`numberMatches`), group key prefixes (`G1:`), and what changed between two versions of a stage (pure) |
| `results.ts` | `submitResult` and `settleStage` |
| `stages.ts` | `endGroupStage`, `startFinalStage`, `finishTournament` |
| `queries.ts` | Reading a stage's matches and players, and inserting a stage |
| `labels.ts` | Round, group and match labels on every screen: "Winners R2", "Losers Final", "Group A · Round 2", "M12", "Match 12" (pure) |
| `bracket-layout.ts` | Where each match goes in the Desk's Bracket tab (pure) |

### Where a tournament stands

`tournaments.state` is `pending` until the start, then `underway`. A two-stage tournament is in `group_stage`, then `between_stages` once the group stage has ended (so the organizer sees who goes through), then `underway` in its final stage. `complete` once finished: the places are fixed and no result can change.

### Creating and starting

The New tournament page takes a name, a format and its options, an optional group stage, and the players in seed order, one or many at a time. Until the start, the Desk's setup panel adds, removes, renames, reorders and shuffles them. `startTournament` checks the setup again, builds the bracket (or splits the players into groups and builds each group), and plans the queue. Players and seeds are fixed from then on.

### Recording a result

The pad scores a match battle by battle; when the judge confirms, `POST /api/matches/<id>/result` calls `submitResult`. In one transaction, under a row lock on the tournament, it:

1. scores the match from its battles with the frozen rules, and refuses one that isn't decided;
2. reads the stage's matches (or the group's), and lets the engine record the winner, or correct it;
3. writes what changed: the players who moved on, the match states, and the score as players read it ("4-2");
4. settles the stage (`settleStage`): an open match with a player who dropped out goes to the other as a forfeit, repeatedly, and a Swiss gets its next round once its latest one is played and rounds remain;
5. plans the queue again (`reconcileQueue`), which frees the stadium and calls the on-deck match.

A result sent twice changes nothing the second time: the match already has that winner.

### Corrections

A different winner for a match that has one is a correction. In a bracket the old winner may already have played later matches; `correctWinner` takes them out, and their results with them. Before that happens the pad, or the Desk, is told which matches would be erased (`needs_confirmation`), and only a confirmed correction goes ahead. The battles of every wiped match are voided with `reset_by_correction`, not deleted. In a round robin or Swiss a correction changes that match only; a later Swiss round keeps its pairings. A group result can't be corrected once the group stage has ended, nor any result once the tournament is finished.

### Dropping a player, and late players

`dropPlayer` marks the player inactive and settles every stage they are in: their open match, and any they would have reached, go to their opponents as forfeits (`matches.forfeit`, no battles, no score). Their results so far stand, a Swiss pairs them no more, and they keep their Pass. In a running Swiss, `addLatePlayer` adds a player with no wins, paired from the next round, so there has to be one left.

### Two-stage tournaments

At the start, players are split into `group_count` groups by snake seeding, and every group is built in the group format, its keys prefixed (`G1:R1-1`) so they are unique in the tournament. Groups are played side by side; in the queue they take turns, since every group's play order starts at 1. A Swiss group plays the suggested number of rounds for its size.

1. **End group stage** (`endGroupStage`) needs every group played out. It ranks each group, marks who goes through (`participants.advanced`) and stores their `final_seed` from `seedFinalStage`. The Desk then lists who advances.
2. **Start final stage** (`startFinalStage`) builds the final stage from those players in that order, stores `started_at`, and plans the queue.

A player who didn't advance keeps their Pass, which says so.

### Finishing

`finishTournament` needs the final stage played out (`finalizeBlockers` in `lib/finalize-check.ts`: no open match, and every Swiss round played). It stores each player's `final_rank` from `placements`; in a two-stage tournament, players who didn't go through come after those who did, by their place in their group. The board then shows the final standings and each Pass the player's place.

### Standings

`lib/standings.ts` gives running standings from the stored matches, through the engine's `standings`: for a round robin and Swiss, for every group of a two-stage tournament, and for a round robin or Swiss final stage. Not for a bracket. Every tie is broken, down to the seed, so they are the places once the stage is over. The Desk shows every table; the board only those of the stage being played (`BoardSnapshot.tables`, once a match of them has a result, the best 10 rows). The Pass gets none.

### Match numbers

Every match has one number for its whole tournament, `matches.number`: "M12" on the Desk and in the Bracket tab, "Match 12" on the board, the pad, in notifications and on the Pass (`matchCode` and `matchTitle` in `labels.ts`). The engine doesn't number matches; `insertMatches` in `queries.ts` does as it stores them, on from the tournament's highest number, under the tournament's lock. `numberMatches` orders them as the queue plays them: by play order, then group, so the matches of the groups interleave. The groups are stored together at the start for that reason; a later Swiss round and the final stage carry on from the last number. A Swiss bye is never played and has no number. A unique index on the tournament and the number backs it up.

### The Desk's tabs and the Bracket tab

Under the stadium cards, a vertical menu on the left shows one tab at a time beside it: Queue, Standings (for the formats that have them), Players, Completed and Bracket; before the start, only Players. Which tabs exist and which one is open is `lib/desk-tabs.ts` (pure). The open tab is in the address (`?tab=players`), so a reload, the back button and the Desk's live refresh keep it, and only that tab's content is rendered. Delete tournament sits at the bottom of the Players tab.

The Bracket tab (`bracket-view.tsx`) shows the whole bracket: a block per group and the final stage, a section per side of a double elimination bracket, and a column per round. `bracketLayout` places each elimination match by its slot in the full bracket, so a bye leaves a gap and every later match is centred between the two that feed it. The old address `/tournaments/<id>/bracket` redirects to it. The board and the Pass don't show the bracket.

## The queue and the calls

`lib/queue.ts` is a pure planner. It gives each active stadium one current match and one on-deck match, in the engine's play order, and skips held matches and players who are already busy. `reconcileQueue` in `lib/venue.ts` runs it under a row lock on the tournament after every start, result, drop, stage change, stadium change and organizer action.

A match moves through `call_status`: `none`, `on_deck`, `called`, `playing`. A called match can start only if its stadium has a judge. An on-deck match can be moved to another stadium whose on-deck slot is empty (`moveOnDeck`); its `notified_status` is cleared, so its players are told the new stadium, and the queue is planned again.

Every change a screen should show bumps `tournaments.board_version`.

## Live updates

Each screen polls an endpoint on BXQ's server and sends the version it already has as a weak ETag (`W/"v<board_version>"`). An unchanged version is answered 304 after one indexed lookup. Polling pauses while the tab is hidden.

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

A result finished offline is stored as an intent and sent once the queued taps are confirmed. A refusal (a correction that needs confirmation, a finished tournament, a conflict) is shown as a problem and not retried in a loop.

## Web push

A player opts in on their Pass. The browser subscribes through the service worker, and `POST /api/public/<slug>/push` stores the subscription against the signed-in player.

- **Sent exactly once.** `matches.notified_status` records what players were last told. `dispatchNotifications` in `lib/push.ts` claims every match where it differs from `call_status` in one `UPDATE … RETURNING`, so concurrent callers can't send twice.
- **Sent after the response,** through Next's `after()`, so a push never slows an organizer's click.
- **Only real push services are accepted** (`lib/push-endpoint.ts`): the server later posts to the stored address, so an open list would let anyone make it call arbitrary addresses.
- **Optional.** Without the VAPID keys the button is hidden and nothing is sent.

## Security and access

| Who | How they get in | What they can reach |
|---|---|---|
| Organizer | A Supabase magic link. Sign-ups are off; `npm run invite` grants access. | Their own tournaments and rules |
| Board | Opens the board link, shows a pairing code, and the organizer approves it on the Desk. Limited per tournament. | The board data of that tournament |
| Judge tablet | Opens the judge link, picks a stadium, and the organizer approves it. One judge per stadium, enforced by a partial unique index. | The current and on-deck match of its stadium; it can score the current one |
| Player | A 4-digit passcode, or the QR code on their slip. One device at a time. | Their own matches, placement and battle scores |

- **Every organizer action checks the organizer.** Server actions and routes look the tournament or match up by the signed-in organizer (`requireOrganizer`, `matchForOrganizer`), so an ID from another organizer finds nothing.
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
    tournaments/               the list, and new/ to create one
    rules/                     rule profiles
  (control)/tournaments/[id]/  BXQ Desk; passcodes/ prints the slips; bracket/ redirects to the Bracket tab
  (judge)/tournaments/[id]/matches/[matchId]/   the organizer's own BXQ Pad
  t/[slug]/                    BXQ Pass; board/ is BXQ Board, judge/ a judge tablet's BXQ Pad
  b/[code]/ · j/[code]/        short links to the board and the pad sign-up
  api/
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
  bracket/                     the bracket engine (pure)
  tournament/                  creating, starting and running tournaments on the engine
  scoring/                     rule profiles and presets, the scoring engine, battle descriptions
  offline/                     the pad's outbox, its IndexedDB storage and its transport
  db/                          the Drizzle schema and client
  queue.ts · venue.ts          the queue planner, and the actions that run it
  access.ts · judges.ts        access for boards and players; judge tablets
  battles.ts · pad.ts          pad operations, and who may use a pad
  board.ts · player-status.ts  what a board and a player are sent
  push.ts · push-endpoint.ts   sending web push; which endpoints are accepted
  control-room.ts              the Desk's queue builder (pure)
  desk-tabs.ts                 the Desk's tabs, and which one is open (pure)
  standings.ts                 running standings tables (pure)
  finalize-check.ts            what still blocks finishing, or ending the group stage (pure)
  config.ts                    APP_NAME, APP_TAGLINE, limits, environment helpers
drizzle/                       SQL migrations
public/sw.js                   the service worker: push and offline pads
proxy.ts                       session refresh for organizer pages
scripts/                       invite an organizer; migrate on deploy
supabase/                      local Supabase config and the invite email template
tests/                         unit, integration and end-to-end tests
docs/                          this document, PRD, design system, brand guide, RFCs
```

Comments, identifiers and file names keep the names they were written with (`control-room.ts`, `call-board.tsx`, `JudgePad`). The screens they belong to are listed in [brand.md](brand.md).

## Testing

| Kind | Where | What it covers |
|---|---|---|
| Unit | `tests/*.test.ts`, `tests/bracket/`, `tests/scoring/`, `tests/offline/` | The bracket engine in every format, standings and placements, match numbers, the Desk's tabs, the bracket layout, setup checks, the scoring engine, the queue planner, the outbox |
| Integration | `tests/integration/` | Results and corrections, players (setup, drops, late entry, delete), the queue, access, judges, push and finishing, against local Supabase: brackets, a round robin, a Swiss tournament and two-stage tournaments (every kind of group, and every kind of final stage). They run with `npm test` when `.env.local` points at a database. |
| End to end | `tests/e2e/*.e2e.mjs` | Eleven suites in a real browser: setting a tournament up (with the Desk's tabs and the Bracket tab), the offline pad, the Desk, a two-stage tournament with its standings, navigation, access, battle scores, judge tablets, themes, the landing page, sign-in |
