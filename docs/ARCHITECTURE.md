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
| `tournaments` | The imported tournament, its format (`tournament_type`, `group_stage`), its rules, the matches ETag, `public_slug`, `short_code`, `board_version`, and the venue switches |
| `participants` | Players, with `passcode`, `sign_in_token` and, once final, `final_rank` |
| `matches` | Challonge's fields, plus the local queue state: `stadium_id`, `call_status`, `call_count`, `held`, `rule_snapshot`, and the learned next-match links |
| `stadiums` | The stadiums of a tournament, in order |
| `battles` | Every tap on a pad. Undo voids a battle and never deletes it. `op_id` is unique. |
| `sync_outbox` | Results on their way to Challonge, for retries and as a record of who reported what |
| `push_subscriptions` | A player's browser push subscription |
| `board_screens` | Screens that asked to show the board, and whether they are approved |
| `judge_screens` | Who judges each stadium: an approved tablet, or the organizer |
| `player_sessions` | The one device each player is signed in on |
| `sign_in_failures` | Wrong passcode attempts, kept briefly to slow down guessing |

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
| `budget.ts` | The request counter behind the budget meter |

### What each action costs

| Action | Requests | How |
|---|---|---|
| List the organizer's Challonge tournaments (optional) | 1 | Only when the organizer asks for the list on the Tournaments page |
| Import | 3 | The tournament, its participants, its matches. By link or ID the first request is the review; the other two follow when the organizer confirms. |
| A review, import or resync refused for the format | 1 | The tournament is read and found to be a format BXQ doesn't run. Nothing else is asked. |
| Resync, nothing changed | 2 | The tournament, then the matches with `If-None-Match`, answered 304. Participants are read again only if their count changed. |
| Send a result | 2 | The score update, then one refresh of the matches |
| Mark underway (optional) | 1 | Per match |
| Finalize | about 4 | A resync, the finalize call, then the participants with their final rank |

### Supported formats and the import review

BXQ runs single and double elimination. `formatSupport` in `support.ts` refuses round robin and Swiss (BXQ's round labels and correction check assume an elimination bracket), free for all (its matches have more than two players) and any tournament with a group stage. It is asked wherever a tournament is read from Challonge: for each row of the organizer's Challonge tournaments, in a review, in an import and in a resync.

An import asks first, in a dialog.

- **By link or ID,** `reviewTournament` reads the tournament (1 request). It returns what the dialog shows and a token: the fields an import stores, signed with `signPayload`, tied to the organizer and valid for 10 minutes. `importReviewed` checks the token and reads only the participants and the matches. The import still costs 3 requests, and a browser can't swap in a format that was refused.
- **From the list,** the details are already on the page, so the dialog opens without a request. Confirming runs `importTournament`, which reads the tournament again and checks its format.

A resync that finds an unsupported format stops after its first request. It records `tournament_type` and `group_stage`, so the Desk can show why, and leaves the stored bracket alone. Finalize resyncs first, so it is refused the same way.

### A 200 is not trusted

Challonge can answer 200 and ignore the change (it does for a tie in an elimination match). After every score update, `report.ts` checks that the match is `complete` with the expected winner. Finalizing checks that the tournament is `complete`. A send that fails stays in `sync_outbox` and the Desk offers Retry.

### Corrections

A correction is one direct update; BXQ never reopens a match. Challonge resets later matches without warning, so before sending, BXQ walks the next-match links it has learned and asks the organizer to confirm any result that would be erased. Afterwards the battles of every wiped match are voided, not deleted.

## The queue and the calls

`lib/queue.ts` is a pure planner. It gives each active stadium one current match and one on-deck match, in Challonge's suggested play order, and skips held matches and players who are already busy. `reconcileQueue` in `lib/venue.ts` runs it under a row lock on the tournament after every result, import, resync, stadium change and organizer action.

A match moves through `call_status`: `none`, `on_deck`, `called`, `playing`. A called match can start only if its stadium has a judge.

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
- **Wrong passcodes are limited:** 10 per player per 10 minutes, and 30 per network per 5 minutes.
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
    public/[slug]/             board, judge, me, push, session: polled by venue devices
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
| Integration | `tests/integration/` | Sync, reporting, the queue, access, judges, push and finalize, against local Supabase and a fake Challonge. They run with `npm test` when `.env.local` points at a database. |
| End to end | `tests/e2e/*.e2e.mjs` | Nine suites in a real browser: the offline pad, the Desk, navigation, access, battle scores, judge tablets, themes, the landing page, sign-in |

The fake Challonge follows the documentation and the recorded fixtures in `tests/fixtures/challonge/`. No test calls the real API, so the tests cost no requests.
