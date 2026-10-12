# RFC-001: Beyblade tournament organizer app on Challonge API v2.1

| | |
|---|---|
| **Status** | Draft. Exploration phase; no feature code yet |
| **Date** | 2026-10-10 |
| **API** | [Challonge API v2.1](https://challonge.apidog.io/) at `https://api.challonge.com/v2.1` (JSON:API) |

## Implementation status

**M1 is done (2026-10-10).** It covers auth, the bring-your-own key vault, tournament import and resync, and a read-only control room. The README has setup instructions. Differences from the plan below:

- **Folder layout.** We kept the `with-supabase` template's root-level `app/`, `lib/` and `components/` instead of moving everything under `src/`.
- **Next.js 16 changes.** Next 16 replaces `middleware.ts` with `proxy.ts`. The template enabled `cacheComponents`, which we turned off because every page reads per-organizer data.
- **Database schema.** Tables live in a private `app` Postgres schema with RLS enabled and the Supabase API roles revoked. `organizer_id` references `auth.users` with `ON DELETE CASCADE`.
- **Token-refresh locking.** Usage from a token refresh is recorded *after* the row-lock transaction commits. Writing it on another pooled connection while holding the lock could exhaust the pool; an integration test with 6 concurrent callers checks this.
- **Not in M1:** `rule_profiles`, `stadiums`, `battles`, `push_subscriptions`, `sync_outbox`, and the `winner_next_match_id`/`loser_next_match_id` columns. Each arrives with the milestone that needs it.

**M2 is done (2026-10-10).** It covers rule profiles, the scoring engine, the judge pad, reporting to Challonge, and corrections.

- **Scoring engine** (`lib/scoring/engine.ts`): pure TypeScript shared by the judge pad and the server.
- **Rule profiles:** four presets in code, plus profiles each organizer can edit. A tournament uses either a preset or one of the organizer's profiles. Each match snapshots its rules into `matches.rule_snapshot` on its first battle.
- **Judge pad taps** are idempotent operations (`battles.op_id`), batched and retried. Undo marks a battle void rather than deleting it.
- **Bracket links** are stored as Challonge IDs (`winner_next_challonge_id`/`loser_next_challonge_id`) rather than foreign keys, so they survive a re-import.
- **Sending a result** is synchronous and costs 2 requests: the score update, a check that Challonge accepted it (`state === "complete"` with the expected winner), then one refresh. Failed sends stay in `sync_outbox`, and the control room offers a retry. A background worker is deferred to M5 (offline support).
- **Corrections** block with a list of the completed downstream matches they would erase. For matches reported outside the app, the check falls back to later completed matches either player has played. After the correction, the battles of any wiped match are voided with `void_reason = 'reset_by_correction'`.
- **Not in M2:** marking a match `underway` on Challonge (comes with calling players in M3), a limit on battles per set, and finalizing the tournament.

**M3 is done (2026-10-10).** It covers the stadium queue, the call board and the player page.

- **Queue planning:** a pure planner (`lib/queue.ts`) gives each active stadium one current match (called or playing) and one on-deck match, in `suggested_play_order`. It skips players who are already busy (relevant for round robin and Swiss) and matches that are held.
- **When the queue updates:** it re-plans under a row lock on the tournament after every result, import, resync, stadium change and organizer action.
- **Calling and starting:** auto-call is on by default and can be turned off, in which case the organizer presses "Call players". The judge's first tap marks a called match as playing. "Mark underway on Challonge" is optional and costs 1 request per match.
- **Live updates use polling, not Supabase Realtime.** Boards, player pages and the control room poll `GET /api/public/<slug>/board`, using `tournaments.board_version` as a weak ETag. An unchanged board costs one indexed lookup and a 304 from our own server, never a Challonge request. This works on any host and needs no realtime service. Switching to Realtime later only changes `useBoard`.
  - **Update (2026-10-12): Realtime added as a hint on top of polling.** A trigger on `tournaments.board_version` calls `realtime.send()` on the public channel `board:<slug>`. The call board and control room subscribe, check the endpoint as soon as a push arrives, and slow their polling to every 60 seconds while connected. Player phones stay on polling (every 10 seconds) to keep within the Realtime connection cap. The push carries no board data, so a forged message can only cause an extra check.
- **Public pages** at `/t/<slug>` (the player page) and `/t/<slug>/board` (the TV) need no sign-in. The slug is 16 random hex characters, and the pages show names and match status only.
- **Call board:** it plays a chime and announces calls with browser text-to-speech once someone taps "Enable sound", since browsers block autoplay until then. It shows a QR code linking to the player page.
- **Player page:** the player picks their name, which is remembered in `localStorage`. It shows whether they are called, playing, on deck, queued or waiting, and vibrates when they are called while the page is open. Notifications when the page is closed arrive with web push in M4.
- **Known limits:**
  - The public endpoint has no rate limiting yet.
  - The QR code uses `APP_URL`. For phones at a venue during local testing, set it to the laptop's LAN address.
  - There is no drag-and-drop to reassign a match to a different stadium.

**M4 is done (2026-10-10).** It covers web push for players.

- **Opt-in:** on the player page the browser subscribes (through `public/sw.js` and VAPID) and `POST /api/public/<slug>/push` stores the subscription against the chosen player. Re-subscribing the same phone as another player moves the subscription. "Not you?" unlinks it.
- **Sending exactly once:** `matches.notified_status` records the call status players were last told about. `dispatchNotifications` claims every match where it differs from `call_status` with a single `UPDATE … RETURNING`, so concurrent dispatchers and retries can't double-send. Releasing a match back to the queue clears the column, so a later call notifies again.
- **Two notifications per match:** "On deck at Stadium N" and "You're up at Stadium N". They share a `tag`, so the second replaces the first. TTLs are short (10 and 3 minutes): a late call is worse than no call.
- **When it sends:** via Next's `after()` from `reconcileQueue`, so pushes go out after the response and after the transaction commits. They don't slow down an organizer's click.
- **Request-forgery protection:** the server later POSTs to the stored endpoint, so only real browser push services are accepted (Google FCM, Mozilla, Windows WNS, Apple), HTTPS only, default port, no credentials. Subscriptions are capped at 2,000 per tournament.
- **Housekeeping:** subscriptions are deleted on a 404 or 410 from the push service, or after 5 consecutive failures.
- **iPhone:** web push only works from a home-screen app, so each tournament serves its own manifest (`/t/<slug>/manifest.webmanifest`, `start_url` set to the player page). The page shows the "Add to Home Screen" steps when opened in Safari. Icons are generated in code (`lib/app-icon.tsx`).
- **Optional by config:** without `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, the button is hidden and nothing is sent.
- **Not verified automatically:** delivery to a real device. It needs a real browser subscription; the steps are in the README.

**M5 is done (2026-10-10).** It covers the offline judge pad.

- **Durable outbox** (`lib/offline/outbox.ts`), stored in the tablet's IndexedDB. For each match it keeps the battles the server last confirmed, the operations not yet confirmed, and optionally an intent to send the result. Taps apply instantly and survive reloads, crashes and lost connections. It has no framework dependencies and takes its storage and transport by injection, so it is unit-tested without a browser.
- **Plain endpoints instead of server actions:** `POST /api/matches/<id>/battles` and `POST /api/matches/<id>/result`. Server action IDs change on every build, so a pad restored from the offline cache after a deploy could never have synced. The endpoints use the session cookie, require a same-origin `Origin`, and answer 401 as JSON (the proxy no longer redirects API calls to the login page).
- **Stale-page guard:** the pad page stamps its render time. The outbox takes the page's battles only if the page is newer than its own last confirmation, because a page served from the cache can be older than what the device already knows.
- **Results while offline:** "Send to Challonge" stores the intent. Once the queued taps are confirmed and the server is reachable, the result is sent automatically. Refusals (a correction needing confirmation, Challonge not connected, a conflict) are kept as a visible problem and are not retried in a loop.
- **One sync loop per device** (`OutboxSync`, mounted in both layouts). It flushes every match's outbox on reconnect, on tab focus, and every 5 seconds while work is pending, not only for the pad on screen. The control room shows a "Saved on this device, not on the server yet" banner listing each such match with the reason.
- **Service worker caching** (`public/sw.js`, hand-written rather than Serwist, whose Next plugin targets webpack while this project builds with Turbopack). Only judge pad pages and `/_next/static` files are cached. Requests are always network-first, with a 5-second stall fallback for pad navigations, so online behaviour and development hot reload are unchanged. The control room pre-loads the pads of matches currently at stadiums. Signing out clears cached pad pages.
- **Verified in a real browser:** `npm run test:e2e` drives the installed Edge or Chrome through going offline mid-match, reloading offline, finishing the match offline, opening a pre-loaded pad offline, and reconnecting.
- **Known limits:**
  - A pad never opened or pre-loaded on a device can't be opened offline (an explanatory page is shown).
  - Syncing needs the app open in a tab. The Background Sync API isn't used because Safari and iPad don't support it.
  - Two tabs on the same match on one device each keep their own in-memory copy of the outbox.

**Control room redesign and queue controls (2026-10-10).** Requested after M5; each choice below was confirmed with the organizer before building.

- **Layout follows the mockup.** A header row (the menu button, "Control room" with the tournament name under it, sync time, Resync), then Stadiums and Queue on the left and a sidebar on the right. The page lives in its own route group (`app/(control)`), so the app navigation bar is hidden here and the page is always dark.
- **Stadium cards** show Now (players, live score) and On deck. A called match has two buttons side by side: "Start match" (wide, filled) and "Recall" (narrow, outline). "Call players" appears only when it can act (the stadium is free and has a match on deck); otherwise a status line explains what happens next. "Send back to queue" is a full-width button under the on-deck players. The per-card menu holds "Open judge pad", Hold, Cancel, Rename and Remove.
- **Queue** is a table (Match, Round, Players, Status, Stadium) with READY, HELD and PENDING rows and a per-row menu. Match labels combine the play-order number and Challonge's letter, e.g. "M18 · R".
- **Sidebar** is built from existing data only: results that failed to send (with Retry), "Waiting to sync to Challonge" (server sends in flight plus anything only on this device), and the rule profile summary with the picker behind "Edit". Conflict resolution ("Keep ours / Use Challonge") and check-in status from the mockup were deliberately left out.
- **Two switches** in Venue settings: "Fill on deck automatically" (`tournaments.auto_on_deck`, new) and "Call automatically" (`auto_call`). With filling off, slots stay empty until the organizer uses "Place on deck at…" from a queue row, which only offers stadiums whose on-deck slot is empty.
- **Recall players** re-announces a called match that hasn't started. The match stays at its stadium; `matches.call_count` goes up and `called_at` is renewed, which makes boards announce it again as "Second call", "Third call" and so on, and both players get another push. There is no limit, and a 15-second cooldown is enforced on the server. The card shows the cooldown as a live countdown under the Now buttons ("Just called. Next recall available in 9s") after every call or recall, with Recall disabled until it reaches zero. The server sends how long was left when it rendered the page and the browser counts from there with its own clock, so a wrong device clock can't shorten the wait. Messages about the current match appear in the same place; messages about the on-deck match or the stadium stay at the foot of the card.
- **Back to queue** (on-deck match): with automatic filling, the match is skipped for that one planning pass, so the next ready match takes the slot and the returned match is eligible again for the next slot that opens. Nothing is stored for this; it is a `skip` option on the planner.
- **Hold** (called or playing match): battles are kept and the match waits as HELD until released.
- **Cancel match** (called or playing): after a confirmation that states how many battles will be voided, the battles are voided with `void_reason = 'cancelled'`, the rule snapshot is cleared, and the match waits as HELD at 0–0.
- **Challonge "underway" mark:** Hold and Cancel remove it when it was set (1 request each).
- **Known limit, accepted:** if a judge's tablet is offline with unsent taps for a match at the moment it is cancelled, those taps sync later and reappear on the cancelled match.
- **Latest battle:** under each live score, the control room's stadium cards and the call board's stadium cards show the most recent battle, e.g. "Latest battle: Alex · Xtreme +3", "Draw · replayed" or "Sam launch error (strike 1 of 2)". The text comes from `lastBattleText` in `lib/scoring/describe.ts`, which reads the same scoring engine as the judge pad.
- **Add stadium** is no longer inside Venue settings. It has two entry points: a button between "Venue settings" and "Open call board", and a dashed tile the size of a stadium card at the end of the stadium grid (the tile is also the empty state).
- **Call board banner** now follows the mockup: a divider between the stadium and the players, and a right-aligned two-line label (round over "Match 14 · K"). Beside the tournament name the board shows the round of the most recently called match (`BoardSnapshot.currentRound`), since several rounds are usually in play at once. The Sound and Full-screen buttons stay visible, by the organizer's choice.
- **Missing values never reach the screen:** `callLabel` returns nothing for a missing or invalid count, and card detail lines skip empty parts. This followed a card showing "undefinedth call" when a dev server served an outdated module after the control room folder was moved (restarting `npm run dev` cleared it).
- **Verified in a real browser:** `tests/e2e/control-room.e2e.mjs` (47 checks), run by `npm run test:e2e` together with the offline-pad suite.

**Shared layout and side navigation (2026-10-10).** Requested after the control room redesign; choices confirmed with the organizer.

- **One header for every signed-in page** (`components/page-shell.tsx`): a full-width bar with the menu button, the page title with an optional subtitle, and page-specific items on the right (for example the control room's sync time and Resync). Tournaments, Rules and Challonge connection now use it, with the same padding as the control room instead of a centered column. Forms keep a readable maximum width.
- **Side navigation replaces the top bar** (`components/side-nav.tsx`). A menu button opens a panel from the left, over the page with the rest dimmed. It is closed on every page load and on every screen size, and closes when a page is picked, on Escape, or when the dimmed area is clicked. Keyboard focus stays inside it while it is open and returns to the menu button afterwards. It holds the three sections (the current one marked), the Challonge API budget meter, the theme switch, the account email and Sign out.
- **The API budget meter lives only in the side navigation.** By the organizer's choice it was removed from the Tournaments, Challonge connection and control room headers. The shared header loads the count for the navigation, so every page has it; it is hidden until a Challonge app is saved.
- **The control room has the same menu button**, so Rules and Challonge connection are reachable from there.
- **No return links in the shared header.** The control room's "‹ Tournaments" link and the rule profile pages' "‹ Rule profiles" link were removed at the organizer's request; you go back through the side navigation, which marks the section you are in. Only the judge pad keeps its "‹ Control room" link, because the control room is not a navigation entry.
- **Theme:** the organizer pages keep the light/dark switch (now in the navigation); the control room, judge pad and public screens stay dark.
- **Verified in a real browser:** `tests/e2e/navigation.e2e.mjs` (25 checks), run by `npm run test:e2e`.

**Local development note (Windows).** Local Supabase runs on ports 44320–44329, not the default 5432x. Windows/Hyper-V reserves random port ranges inside the dynamic range (49152 and up) after reboots, and on 2026-10-10 it reserved 54257–54356. That made Docker fail with "bind: An attempt was made to access a socket in a way forbidden by its access permissions". Ports below 49152 avoid the problem.

## Goal

Build a web app that helps organizers run Beyblade X tournaments that are hosted on Challonge. It should:

- call the next players to a stadium, both on a venue board and by push notification to their phones
- make score entry fast, using the Beyblade X finish types (Spin, Over, Burst, Xtreme) and configurable rules
- keep Challonge's bracket up to date without using up the API request budget

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Source of truth | **Local-first with write-through sync.** Our Postgres database holds the live state. Each completed match is pushed to Challonge, and the match list is re-read only after our own writes or when the organizer taps "Resync". |
| 2 | Calling players | **Venue call board** (TV page), plus **PWA web push** for players who opt in |
| 3 | Scoring | **Configurable rule profiles** with a per-battle log |
| 4 | Auth | **Multi-organizer OAuth** (authorization code flow) |
| 5 | Connectivity | **Cloud web app** plus an **offline-tolerant PWA** for judges, with an IndexedDB outbox |
| 6 | Credentials | **Every organizer brings their own Challonge OAuth app** (client ID and secret) |

## Constraints from the Challonge API

- **Request budget:** the free tier allows 500 requests per month, and requests over the limit get HTTP 429 (the grace period ended in mid-2026). Because each organizer brings their own keys, each organizer has their own budget or paid plan.
- **No webhooks or websockets:** changes made outside our app can only be detected by polling.
- **Coarse scores:** `score_set` is a comma-separated number per game or set. It has no notion of finish types, so the battle-by-battle log has to live in our database.
- **Tokens:** OAuth access tokens expire after 1 week, and a refresh token is returned alongside them.
- **Docs need verifying:** the documentation has gaps. Scopes aren't listed per endpoint, and some schema defaults look copy-pasted. The spikes need to check real behaviour.

### What "bring your own keys" means for the design

1. **We need our own login (email magic link).** The OAuth flow can't start until we know which organizer's client ID to use, so Challonge is a *connection* attached to our account, not the login itself.
2. **Onboarding must walk the organizer through** creating an app at connect.challonge.com, entering our redirect URI there, and pasting the client ID and secret back to us.
3. **Client secrets and tokens are encrypted at rest** with AES-256-GCM, using a versioned key held in an environment variable. They never reach the browser.

## 1. Architecture

```
┌──────────────────────────── Devices at the venue ────────────────────────────┐
│ Organizer console     Judge pad (organizer     Call board (TV)  Player phone  │
│ (control room)        session on a tablet)     /t/{slug}/board  /t/{slug}/me  │
│      │                     │  IndexedDB outbox      ▲            ▲ web push   │
│      │                     │  (offline queue)       │            │ (PWA)      │
└──────┼─────────────────────┼────────────────────────┼────────────┼────────────┘
       │ HTTPS               │ sync on reconnect       │ realtime   │
┌──────▼─────────────────────▼────────────────────────┴────────────┴────────────┐
│ Next.js app (server)                                                           │
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────┐  ┌────────────────┐   │
│  │ Auth + BYO   │  │ Scoring engine   │  │ Stadium     │  │ Notifier       │   │
│  │ key vault    │  │ (pure; driven by │  │ queue engine│  │ realtime       │   │
│  │ (encrypted)  │  │  rule profiles)  │  │ (next up)   │  │ broadcast +    │   │
│  └──────┬───────┘  └────────┬─────────┘  └──────┬──────┘  │ web push       │   │
│         │                   └─────────┬─────────┘         └───────▲────────┘   │
│         │                     ┌───────▼────────┐                  │            │
│         │                     │ Postgres       │──────────────────┘            │
│         │                     │ (source of     │                               │
│         │                     │  truth)        │                               │
│         │                     └───────┬────────┘                               │
│  ┌──────▼─────────────────────────────▼───────────────────────────┐            │
│  │ Challonge sync layer: per-organizer client · budget meter ·    │            │
│  │ sync_outbox worker (push scores) · importer · reconciler       │            │
│  └──────────────────────────────┬─────────────────────────────────┘            │
└─────────────────────────────────┼──────────────────────────────────────────────┘
                                  ▼
                   api.challonge.com/v2.1 (organizer's own OAuth app)
```

**Proposed stack:**

| Layer | Choice |
|---|---|
| App | Next.js (App Router) and TypeScript |
| Database | Postgres (Supabase or Neon) with the Drizzle ORM |
| Validation | Zod |
| Realtime | Supabase Realtime broadcast channels, or SSE if self-hosted |
| Offline | Serwist (service worker) and Dexie (IndexedDB) |
| Push | `web-push` with VAPID keys |
| UI | Tailwind CSS and shadcn/ui (see section 4) |

### Flows

**A. Onboarding**

1. The organizer signs up with a magic link.
2. The settings page shows our redirect URI and a step-by-step guide to creating a Challonge app.
3. The organizer pastes in the client ID and secret, which are stored encrypted.
4. "Connect Challonge" redirects to `https://api.challonge.com/oauth/authorize` with the scopes `me tournaments:read tournaments:write matches:read matches:write participants:read participants:write`.
5. The callback exchanges the code at `/oauth/token` using that organizer's credentials and stores the tokens encrypted.

The `state` parameter carries a signed organizer ID, so the callback knows which credentials to use.

**B. Import a tournament**

1. The organizer picks a tournament.
2. We pull the tournament, its participants and its matches. This costs about 1 + ⌈n/per_page⌉ + ⌈m/per_page⌉ requests.
3. The organizer assigns a rule profile and sets up the stadiums.

**C. Live loop**

```
open matches (sorted by suggested_play_order) → queue engine assigns a free stadium
  → status "called" → board broadcast + push to both players ("Stadium 2, now")
  → organizer starts the match → judge pad logs battles (finish type → points)
  → engine detects target reached → organizer confirms the result
  → sync_outbox: PUT /tournaments/{t}/matches/{m}.json with score_set per set
  → coalesced refresh: GET matches (at most once every N seconds) → newly opened matches join the queue
```

**D. Reconcile**

Reconciliation runs when the organizer taps "Resync", and automatically before finalizing:

1. Pull everything from Challonge.
2. Compare it with the local data.
3. Put any mismatch (for example, a score edited on challonge.com or a bracket reset) into a **conflict list** for the organizer to resolve.

Conflicts are never overwritten silently.

### Idempotency: two outboxes

- **Device → server:** every battle tap has a client-generated `op_id` (UUID) with a unique constraint in the database, so replaying a tap after a reconnect is harmless.
- **Server → Challonge:** each `sync_outbox` row is pushed once and retried with backoff. A 422 response (for example, the match is no longer open) moves the row to the conflict list instead of retrying.

### Data model sketch

| Table | Key fields |
|---|---|
| `organizers` | Our own identity |
| `challonge_connections` | `client_id`, `client_secret_enc`, `access_token_enc`, `refresh_token_enc`, `expires_at`, `scopes`, `challonge_user_id` |
| `tournaments` | `challonge_id`, `community_id?`, `public_slug`, `rule_profile_id`, `last_synced_at` |
| `participants` | `challonge_id`, `name`, `seed` |
| `matches` | Challonge fields (`round`, `identifier`, `suggested_play_order`, `state`, `player1/2`, the last two read from `points_by_participant`) plus local fields (`local_status`, `stadium_id`, `sync_status`, and `winner_next_match_id`/`loser_next_match_id`, learned from refreshes; see S4b) |
| `battles` | `match_id`, `set_no`, `seq`, `scorer_participant_id`, `finish_type`, `points`, `op_id` (unique), `voided_at` |
| `rule_profiles` | `finishes[{key, points}]`, `target_points`, `best_of_sets`, `cap_at_target`, `own_finish`, `penalties`, `draw_policy`, `max_battles?`, `round_overrides[]` |
| `stadiums` | `tournament_id`, `name`, `position` |
| `push_subscriptions` | `participant_id`, `endpoint`, `keys` |
| `sync_outbox` | `kind`, `payload`, `attempts`, `status`, `last_error` |
| `api_usage` | `connection_id`, `month`, `count` |

### Default rule presets

The common baseline is Spin = 1, Over = 2, Burst = 2, Xtreme = 3, with draws replayed. Events vary on the rest: first to 4, 5 or 7; best-of-3 sets in finals; and whether an own finish (a self-KO) concedes only 1 point.

The presets are starting points. Organizers can copy and edit them.

## 2. Proposed file layout

The repo is empty, so every file below is new.

```
.env.example                      # DATABASE_URL, APP_ENCRYPTION_KEY, VAPID_*, AUTH_* (no Challonge keys: those are per organizer)
next.config.ts · drizzle.config.ts · package.json · tsconfig.json
docs/rfc-001-architecture.md
src/
  app/
    (auth)/login/page.tsx
    (organizer)/settings/challonge/page.tsx              # BYO key entry + connection status
    (organizer)/rule-profiles/[id]/page.tsx
    (organizer)/tournaments/page.tsx                     # list / import
    (organizer)/tournaments/[id]/page.tsx                # control room
    (organizer)/tournaments/[id]/matches/[mid]/page.tsx  # judge pad
    t/[slug]/board/page.tsx                              # public call board (TV)
    t/[slug]/me/page.tsx                                 # player opt-in
    api/challonge/oauth/start/route.ts
    api/challonge/oauth/callback/route.ts
    api/battles/sync/route.ts                            # device outbox ingest
    api/push/subscribe/route.ts
    api/jobs/challonge-sync/route.ts                     # outbox worker trigger
    manifest.ts · sw.ts
  lib/
    challonge/client.ts       # JSON:API fetch wrapper: headers, community_id, pagination, 429 handling
    challonge/oauth.ts        # per-organizer token exchange / refresh
    challonge/budget.ts       # counts every request; warns/blocks near the limit
    challonge/types.ts
    challonge/sync/{import,push-score,refresh,reconcile}.ts
    scoring/profile.schema.ts · scoring/engine.ts · scoring/to-score-set.ts · scoring/presets.ts
    queue/stadium-queue.ts
    notify/{realtime,push}.ts
    crypto/secrets.ts         # AES-256-GCM, key versioning
    offline/outbox.ts         # Dexie, client only
    db/{schema,index}.ts
  components/{ui,judge-pad,call-board,control-room,player}/…
tests/
  scoring/engine.test.ts      # table-driven rule cases
  challonge/fixtures/         # real API responses recorded during the spikes
```

Build `scoring/engine.ts` and `challonge/client.ts` first, with tests. Everything else depends on them.

## 3. Risks and spikes

| # | Spike | Questions | Effort |
|---|---|---|---|
| S1 | Bring-your-own OAuth onboarding | Can any organizer create a free Sandbox app without approval? Can one app register both our domain and `localhost` as redirect URIs? Does the refresh token keep working after the 1-week access-token expiry? Could the client-credentials flow with `application:manage` see tournaments created on challonge.com? If it can, it may replace the redirect flow. | 0.5–1 day |
| S2 | Request budget in practice | Do token refreshes or 304 responses (sent in reply to `If-None-Match`) count toward the limit? What is the largest allowed `per_page` for matches? How many requests does a real 16-player double-elimination event use? | 1 day |
| S3 | Detecting bracket progression | Does the v2.1 match model expose prerequisite or next-match links, or must we re-fetch after each report? Can several reports share one refresh? | 0.5 day |
| S4 | Score semantics | Do multi-set `score_set` values work? How should a score over the target (Xtreme at 3–2) be reported? How do `rank` and `advancing` behave in a grand-finals reset, Swiss and round robin? | 0.5 day |
| S5 | Offline PWA and push | Does Serwist work with the current App Router? Does IndexedDB outbox replay work? How does iOS push behave, given it only works after the PWA is added to the home screen (iOS 16.4+)? | 1–1.5 days |

The current estimate for a 32-player double-elimination event is about 150–220 requests, so 2–3 events a month fit the free tier. S2 and S3 will refine that number.

**Design risks (no spike needed):**

- **Encryption keys:** keys need rotation. A failed token refresh should show a "Reconnect Challonge" banner.
- **Outbox worker hosting:** Vercel Hobby cron jobs run once a day at most. Use Inngest, QStash or Supabase `pg_cron` instead.
- **Edits on challonge.com mid-event:** these are handled by the reconciler.
- **`community_id`:** support it from day one.
- **Doc errors:** use recorded fixtures as contract tests.

**Assumptions:**

- In v1, only logged-in organizer sessions can score. Judge invite links can come later through a `tournament_staff` table.
- Players opt in to push by picking their name. A check-in code is optional.

### Spike findings (2026-10-10, first run)

**S1 (bring-your-own OAuth): passed.** These were tested against a real Developer Portal app:

- **Token request format:** `POST /oauth/token` accepts a standard **form-encoded body**. The docs' "query params" description isn't needed.
- **Scopes:** all seven requested scopes were granted as requested (`me`, `tournaments:*`, `matches:*`, `participants:*`).
- **Token lifetime:** `expires_in` is 604,800 seconds (7 days), and a refresh token is issued with it.
- **Refresh rotation:** a refresh **rotates the refresh token**, and the new access token works. Design impact: the new refresh token must be saved atomically with the access token. Don't rely on the old one still working.
- **Tournament IDs:** the URL slug (`xl4tobg6`) works as `tournament_id`, as well as the numeric ID.
- **Not yet tested:** the client-credentials flow (`npm run s1:cc`).

**S2 (request budget): mostly answered.** These results come from a started 16-player double-elimination bracket with 31 matches (including a possible grand-finals reset):

- **The whole bracket fits in one request.** `per_page=100` and `per_page=500` both returned all 31 matches. A full refresh therefore costs **1 request**, not ⌈m/25⌉. Any server cap above 31 is still unknown. Every list response has `meta.count` and `links.next`/`prev`, so the client should still follow `links.next`.
- **Conditional requests work.** Responses carry a weak `ETag` and `Cache-Control: private, no-store`, and sending `If-None-Match` returns **304**. The matches ETag changed when the tournament started (`md5("/")` while empty, then a new value), so it does track match changes. **Still open:** whether 304s and OAuth token calls count toward the budget. To find out, compare the Developer Portal usage with `spikes/out/requests.jsonl`.
- **ETags look like cache keys, not hashes of the response body.** The tournament list and the single tournament share an ETag. Possible risk: a change to a related record (such as a participant rename) may not change the matches ETag. Treat 304 as "matches unchanged", not "nothing changed".
- **The tournament payload is rich.** It includes `participants_count`, `oauth_application_id`, `station_options`, `match_options` and `double_elimination_options`, plus relationship counts.
- **Revised budget estimate:** about 1 score PUT and 1 refresh GET per match (more in practice if refreshes are coalesced). A 32-player double-elimination event (about 63 matches) comes to roughly **130 requests**, or about 190 if every match is also marked underway. That's 2–3 events per month on the free tier, or more if 304s turn out to be free.

**S3 (bracket progression): answered. Matches have no links to the next or previous match.** Match attributes are `state`, `round`, `identifier`, `suggested_play_order`, `scores`, `score_in_sets`, `points_by_participant`, `timestamps` (including `underway_at` and `started_at`), `winner_id`, `tie`, `location` and `scheduled_time`. The only relationship is `attachments`.

Consequences:

- After each reported score, we **re-fetch the match list** (1 request) to find newly filled slots. Several reports close together can share one refresh.
- Losers-bracket rounds are **negative** (`-1` to `-6` here). The queue engine and the UI have to label them, e.g. "Losers R3".

**Where the docs are wrong:** the players are **not** in `relationships.player1`/`player2`. They're in `attributes.points_by_participant[].participant_id`, and the ID is `null` until the slot is filled. Our Challonge client should hide this behind a single `playersOf(match)` helper, as `spikes/lib/challonge.mjs` now does.

**S4 (score semantics): answered.** Each step below is one request:

| Test | What Challonge did | Design consequence |
|---|---|---|
| `mark_as_underway` | Set `timestamps.underway_at`. The response has no other new fields. | Fine to use, but it costs 1 extra request per match. Make it optional per tournament. |
| Single set, over the target (`"5"` vs `"2"`) | Stored exactly as sent: `scores: "5 - 2"`, match `complete`, `winner_id` set. No validation against any target. | Capping scores at the target is **purely our rule profile's decision**. Default: report the actual points. |
| **One report → bracket progression** | **3 matches changed**: the reported match, the winner's next match (Winners R2), and the loser's slot in the losers bracket (round `-1`). | Confirms the plan of **1 PUT plus 1 refresh GET per match**. One refresh picks up both new slots. |
| `reopen` | Match went back to `open` and `winner_id` was cleared, but **`scores` and `underway_at` were kept, and neither downstream match was cleared** (the winner and loser stayed in their next slots). | Never treat "reopened" as "bracket rolled back". Corrections need their own flow (see the open questions below). |
| Best of 3 sets (`"4,2,4"` vs `"1,4,3"`) | `scores: "2 - 1"` (sets won), `score_in_sets: [[4,1],[2,4],[4,3]]`, complete, correct winner. | Multi-set formats (e.g. best-of-3 grand finals) work natively. Send each set's points, one value per set. |
| `tie: true` on an elimination match | **HTTP 200, but the tie was silently ignored.** Scores were stored as `3 - 3`, the match stayed `open`, `winner_id` stayed null and `tie` stayed false. | **A 200 response does not mean the result was accepted.** After every score PUT, check that the response has `state === "complete"` and the expected `winner_id`. Otherwise, send the row to the conflict list. Our scoring engine must never produce a tie in elimination formats (draws are replayed anyway). |

The fact that `open` matches accept partial scores also means we *could* push live scores during a match. That costs budget, so it's out of scope for v1.

**Budget accounting: inconclusive.** After 32 logged requests (2 token calls, 2 304s, 9 writes), the Developer Portal showed **0 requests** for the 2026-09-10 to 2026-10-10 window. Possible explanations:

1. The usage counter updates with a delay, e.g. a daily rollup.
2. Today isn't inside the reporting window yet.
3. Requests made through user OAuth tokens aren't counted against the app.

Re-check the portal on 2026-10-11 or later. **Design stance until then:** the app keeps its **own request counter per connection** (`api_usage`) and treats every request as counted, including 304s and token calls. The budget meter in the UI uses our count, not Challonge's.

**S4b (correcting a result): answered.** Run with `spikes/s5-correction.mjs` (12 requests):

| Test | What Challonge did |
|---|---|
| **Flip the winner of a completed match directly** (no reopen), with the next matches not yet played | 200. The match stayed `complete` with the new winner. **Both downstream slots swapped automatically**: the new winner moved into Winners R2, and the new loser into Losers R1. |
| Play the next match (Winners R2), then **flip the original match again** | **200 with no warning, but it cascaded destructively.** The already-completed Winners R2 match was **reset to `open` and its 4–0 result wiped**. The new winner replaced the old one in it, the old winner's slots in Winners R3 and Losers R2 were cleared, and Losers R1 swapped players. |
| `reopen` after that | 200. The match went back to `open` and its winner was cleared, but nothing downstream changed. This confirms S4: **reopen never rolls back the bracket**. |

**Design consequences:**

1. **A correction is a single direct PUT.** We never use `reopen`, and the UI doesn't offer it.
2. **Challonge doesn't warn about destructive corrections, so we have to.** Matches don't expose their links to the next match (S3), so **we learn the links ourselves**. In the refresh after each reported result, the match the winner landed in is `winner_next_match_id`, and the one the loser landed in is `loser_next_match_id`. We store both on `matches`.
3. **Before sending a correction**, walk those links. If any downstream match is `complete`, show a blocking confirmation such as: "This will erase the result of Winners R2 · M9 (Alex 4–0 Sam) and send it back to the queue." For matches whose links we never learned (because they were reported outside the app), show a generic warning instead.
4. **After the correction's refresh**, the local battle logs of every wiped match are **voided, not deleted**. Those matches go back into the stadium queue, and the call board and push notifications re-announce them.
5. Every correction is recorded with who made it and when (an audit log in `battles`/`sync_outbox`), because it can change who plays whom.

**S1b (client credentials): works, but it's not a replacement for user tokens.** Run with `spikes/s1b-client-credentials.mjs` (5 requests):

- **The grant works with the organizer's own app.** `grant_type=client_credentials` with `scope=application:manage` succeeded (form body, 7-day expiry, no refresh needed: you just request a new token).
- **The app token only works on application routes.** `GET /application/tournaments.json` returned the `[SPIKE]` tournament, whose `oauth_application_id` is 59158. The normal routes (`/tournaments.json`, `/tournaments/{id}.json`, `/me.json`) all returned **403**.
- **Decision:** keep the **authorization-code flow** as the only way to connect in v1. Client credentials stay a possible future option for background jobs, but they would need the undocumented `/application/...` routes for matches and participants. **Not pursued.**

**Still open:**

- **Budget accounting.** The scripts have now made 49 requests. Re-check the Developer Portal counter after 2026-10-11, when it showed 0 earlier.
- **S5 (offline PWA and push):** a code spike, done during M5.

## 4. UI/UX

### Base: Tailwind CSS + shadcn/ui, without a full SaaS template

| Option | Verdict |
|---|---|
| **Next.js `with-supabase` example** (`npx create-next-app -e with-supabase`) plus **shadcn/ui** | **Recommended scaffold.** It already wires up the App Router, Tailwind, shadcn/ui and Supabase auth (magic link), which is close to our stack. |
| shadcn/ui **blocks** (`sidebar-*`, `dashboard-*`, `login-*`) | Use them for the organizer console: sidebar navigation, tables, forms and dialogs. They are copied into the repo, so we own and can change them. |
| Full admin/SaaS templates (e.g. SaaS starters, dashboard starter kits) | Skip them. They bring billing, team and auth assumptions we would have to remove, and they don't help with the parts that matter: the judge pad and the call board. |
| Mantine or MUI | Fine libraries, but heavier and less suited to the custom, game-like screens. |

Supporting libraries: `lucide-react` for icons, `qrcode.react` for player opt-in QR codes, and `sonner` for toasts. Motion (Framer Motion) is optional, for "now calling" animations on the board.

The organizer console should use the standard component kit. The judge pad and the call board should be designed custom, because those screens are what makes the product useful.

### Four surfaces with different constraints

| Surface | Device and context | Design rules |
|---|---|---|
| **Control room** (organizer) | Laptop or tablet. Dense information; the organizer is multitasking. | One lane per stadium (Now playing / On deck), a queue list, a conflicts badge, a sync-status indicator and a **monthly API budget meter**. Every action is undoable. |
| **Judge pad** | Tablet or phone, often in landscape. Noisy venue, fast taps, may be offline. | Screen split into left and right halves that **match the physical sides of the stadium** (with a swap-sides button). Large finish buttons (≥ 80 px) labelled with the finish name, its points and an icon. A running score with a set indicator. **A prominent Undo instead of confirmation dialogs**; the only confirmation is when the target is reached ("Player A wins 4–2, submit?"). Launch errors and penalties go in a secondary row. An offline badge with a count of pending items. Screen Wake Lock keeps the display on, plus haptic feedback on tap. |
| **Call board** | TV or projector, read from 3–5 m away. | Dark theme by default with very large type: one card per stadium showing "NOW" and "ON DECK". New calls animate in with a chime and optional text-to-speech ("Stadium 2: Alex versus Sam"). A permanent QR code for player opt-in. Must work without a mouse or interaction (kiosk mode). |
| **Player page** | The player's own phone. | Shows their next match, stadium and status, and an "Enable notifications" button. On iOS, step-by-step "Add to Home Screen" instructions are shown first. |

### Visual language

- **Finish types have a consistent color and icon everywhere**, for example Spin = blue, Over = amber, Burst = red, Xtreme = violet. Never use color alone: every finish also has a label and an icon, for color-blind users.
- **The look** is energetic and arena-like (dark surfaces, neon accents), carried through design tokens, so light mode still works for the console.
- **No official Beyblade, Takara Tomy or Hasbro logos or trademarked artwork.** Use our own name and identity.
- **Accessibility:** WCAG AA contrast, touch targets of at least 48 px (80 px or more on the judge pad), and visible focus states.

### Design process

1. Make low-fidelity clickable mockups of the four surfaces before writing code, and use them to agree on layout.
2. Test the judge-pad mockup with a real judge at a local event if possible. Its speed and resistance to mis-taps matter more than anything else.
3. Turn the mockup decisions into Tailwind theme tokens and shadcn component variants.

## Appendix: Spike runbook (what the organizer must provide)

1. **A Challonge Developer Portal app** at https://connect.challonge.com:
   - Redirect URI: `http://localhost:3000/api/challonge/oauth/callback` (the production URI is added later)
   - Write down the client ID and client secret, and keep them out of the repo
2. **A throwaway test tournament** on that Challonge account:
   - Name starting with `[SPIKE]` (the S4 script refuses to modify anything else)
   - Double elimination, 16 placeholder participants, not started
3. **Note the plan tier and current usage** shown in the Developer Portal before starting, so the request counts in S2 can be checked against it.

The spike scripts and the steps to run them are in [../spikes/README.md](../spikes/README.md). The UI mockups are at https://claude.ai/artifact/KHhkx7JQYnxNUwaesqSHD2 (private until it is shared).
