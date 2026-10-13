# RFC-001: Beyblade tournament organizer app on Challonge API v2.1

| | |
|---|---|
| **Status** | Draft. Exploration phase; no feature code yet |
| **Date** | 2026-10-10 |
| **API** | [Challonge API v2.1](https://challonge.apidog.io/) at `https://api.challonge.com/v2.1` (JSON:API) |

> **Naming.** The app is now called **BXQ**, and its screens have names of their own. This RFC predates them and keeps its original wording: "control room" is **BXQ Desk**, "call board" is **BXQ Board**, "judge pad" is **BXQ Pad**, and "player page" is **BXQ Pass**. See [brand.md](brand.md).

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
- **Theme:** the organizer pages keep the light/dark switch (now in the navigation); the control room, judge pad and public screens stay dark. (Changed on 2026-10-12: the control room now follows the switch too; see below.)
- **Verified in a real browser:** `tests/e2e/navigation.e2e.mjs` (25 checks), run by `npm run test:e2e`.

**M6 is done (2026-10-12).** It covers finalizing a tournament and restricting the two public screens. Each choice below was confirmed with the organizer before building.

- **Finalize tournament** (`lib/challonge/finalize.ts`): a button in the control room header, enabled only when no match is open and no result is unsent or failed; otherwise it says what is left (`lib/finalize-check.ts`). A confirmation states that it can't be undone on Challonge.
  - **Requests:** about 4. A resync first, so a change made on challonge.com is noticed before asking; the finalize call (`PUT /tournaments/{id}/change_state.json`, state `finalize`); then the participants with their `final_rank`.
  - **A 200 is not trusted** (as in spike S4): the response must say the tournament is `complete`. A 422 is shown with Challonge's own reason.
  - **Standings:** `participants.final_rank`. The call board switches to a podium and the full list, and each player page shows that player's placement. If the standings can't be read, the tournament is still final and the header offers "Load standings" (1 request).
  - **The control room is not locked** after finalizing, by the organizer's choice.
  - **A leftover pending match doesn't block finalizing**, because a grand-finals reset that isn't needed stays pending. Only open matches count as unplayed.
- **Call boards are approved by the organizer** (`lib/access.ts`, `board_screens`). Opening `/t/<slug>/board` shows a 4-character pairing code and nothing else. The control room's "Call boards" panel lists the request with its code and device, with Approve and Decline.
  - **Limit:** `tournaments.board_limit`, default 1, changed in Venue settings (up to 10). It counts approved screens, so a TV that was switched off keeps its place until it is disconnected. At the limit, Approve is disabled.
  - **Count:** the panel shows "1 of 1" and, per screen, "Open now" or when it was last seen. A screen counts as open while it has checked in within 150 seconds (boards check in at least once a minute).
  - **Disconnect** removes the screen's access at once. The screen says so and waits for someone to press "Ask to show the board"; it doesn't ask again by itself.
  - **The organizer's own "Open call board" also goes through approval** and counts, so the number is honest.
  - **Requests nobody answers** expire after 15 minutes, and at most 8 can wait at a time, because the request page is public.
- **Player pages need a passcode, on one device per player** (`player_sessions`).
  - **Passcodes:** 4 digits per player (`participants.passcode`), created with the player and kept through every re-import. They are stored readable, because the organizer has to hand them out.
  - **Sign-in:** pick your name, then type the passcode. The name list is still shown before sign-in (names only, no match data).
  - **Personal QR code:** each slip's QR opens `/t/<slug>#k=<secret>` with a 32-character secret (`participants.sign_in_token`). The secret is after the `#`, which browsers never send to a server, so a link preview or scanner that fetches the address can't sign in, and can't sign the real player out.
  - **One screen:** signing in on another device replaces the session. The previous device is told why on its next check, and its push subscription is removed, so only one phone gets the calls.
  - **Wrong guesses:** 10 per player per 10 minutes, after which even the right passcode is refused until the window passes; and 30 per network per 5 minutes. The network limit is loose because a whole venue usually shares one address. The QR code still works for a locked player.
  - **Control room:** "Players and passcodes" lists every passcode, whether the player is signed in and on what device, and "New passcode", which also signs the player out, replaces the QR secret and lifts a lock. "Print passcode slips" opens a page with one slip per player.
  - **A signed-in player is sent only their own match** (`GET /api/public/<slug>/me`): stadium, opponent, call number, live score, queue position, and their placement once the tournament is final. The link to the full call board is gone.
- **The open endpoint is closed.** `GET /api/public/<slug>/board` now needs an approved screen's cookie, and push subscriptions need a signed-in player. The control room reads its own organizer-only endpoints (`/api/tournaments/<id>/version` and `/access`). The Realtime channel stays public because it carries no board data.
- **Sessions** are httpOnly cookies, one per tournament; only a SHA-256 hash is stored. Endpoints that act on a cookie refuse cross-site requests.
- **Known limits:**
  - Finalizing has only run against the fake Challonge in the tests. The fake follows the documentation, not a recorded response, so the first real finalize is unverified until it is run on a `[SPIKE]` tournament.
  - Whether Challonge accepts a correction after finalizing is untested. The app sends it as before and shows Challonge's answer.
  - On an iPhone, Safari and the home-screen app are two devices. A player who signs in in Safari and then installs the app signs in again there, which moves them.
  - A closed board still shows "Open now" for up to 150 seconds.
  - Anyone at the venue can lock a player's typed sign-in for up to 10 minutes with wrong guesses. The player's QR code and "New passcode" both get around it.
- **Verified in a real browser:** `tests/e2e/access.e2e.mjs` (46 checks), run by `npm run test:e2e`.

**Battle scores of finished matches (2026-10-12).** Requested after M6; each choice below was confirmed with the organizer before building.

- **What it shows:** every battle of a finished match in the order it was played: battle number, the player, the finish and its points, and the set's score after that battle. Draws and launch-error strikes are listed without points. Best-of sets are grouped under a heading per set with that set's score. The lines come from `sheetLines` in `lib/scoring/describe.ts`, which replays the match through the same scoring engine as the judge pad.
- **Finished only:** a match appears once its result is on Challonge (`state = complete`). A match in progress keeps showing only its live score, by the organizer's choice.
- **Control room:** each row of the Completed list has "View battles", which opens a dialog. The battles are read when it opens (`organizerSheet` in `lib/battle-sheet.ts`), so the page itself doesn't grow.
  - **Undone battles** are hidden by default. A "Show undone battles" switch lists them in place, struck through, with the reason: undone by the judge, match cancelled, or reset by a correction. They have no number and no score, because they don't count.
- **Player page:** "Your matches" lists the player's own finished matches, latest first, as "Won 4–3 vs Riley". Opening one shows its battles. Voided battles and other players' matches are never sent to a phone (`GET /api/public/<slug>/me/matches`, behind the player's session).
  - **Updates without extra load:** the player feed carries a short `results` value that changes only when one of that player's results does. The phone reloads its matches when that value changes, not on every change to the board.
- **No record:** a result entered directly on challonge.com has no battles, so both views show its total with "No battle record: this result was entered on Challonge."
- **Scores read in bracket order** (player 1 first) in both views; the player page says which name is first.
- **Not changed:** the call board and the judge pad. No Challonge requests are involved.
- **Verified in a real browser:** `tests/e2e/battle-scores.e2e.mjs` (21 checks), run by `npm run test:e2e`.

**Short links, judge tablets and "no judge, no start" (2026-10-12).** Requested after the battle scores; each choice below was confirmed with the organizer before building.

- **Short links:** every tournament has a 6-character code (`tournaments.short_code`, made by the SQL function `app.short_code()`, no look-alike characters). `/b/<code>` opens the call board and `/j/<code>` the judge sign-up, typed in any case. The Call boards and Judges cards show them large and without `https://`. Clicking a link copies its full address; it doesn't open the page. A tooltip on hover or focus says "Click to copy", and "Copied" after a click (the shadcn Tooltip, `components/ui/tooltip.tsx`). The "Open call board" link next to Add stadium was removed at the organizer's request, so the board is opened by pasting its short link, and goes through approval like any screen. Both links only lead to screens that still need approval, which show the tournament name and, for judges, the stadium names.
- **Judge tablets** (`lib/judges.ts`, `judge_screens`): a judge opens the judge link, picks a stadium, and the tablet shows a pairing code. The Judges card lists the request ("wants to judge Stadium 2") with Approve and Decline. A waiting tablet can change its stadium and keeps its code.
  - **No organizer sign-in.** An approved tablet holds its own httpOnly cookie. It can read its stadium's current and on-deck match and score the current one, and nothing else: not other stadiums, the queue, finished matches or the control room.
  - **One judge per stadium**, enforced by a partial unique index. A second request can't be approved until the first judge is disconnected, from the stadium card's menu.
  - **The tablet follows its stadium.** Between matches it shows a waiting screen; when a match is called there, its pad opens by itself, and after a result "Next match" returns to waiting.
  - **Results:** a judge sends the result to Challonge on the organizer's connection (the same 2 requests as before). Correcting a result that is already on Challonge stays with the organizer.
  - **Judge names:** a judge starts with the detected device name ("Chrome on Android") and can change it on the sign-up screen and, once approved, on the waiting screen. The organizer can also rename a judge from the stadium card's menu. The control room shows the name only; a blank name goes back to the device name (`judge_screens.name`, up to 30 characters).
  - **A judge can leave their stadium** from their own stadium screen ("Leave this stadium"; not on the pad). With a match at the stadium, called or being played, it asks first and says the score is kept. Only the judge row is removed (`leaveStadium`): the match keeps its status and every battle, so the next judge approved for the stadium, or the organizer, opens the same pad with the same score and no second Start. Leaving is refused while the device still holds unsent taps or a result ("1 tap is still saving. Reconnect, then try again."), because once it is no longer the judge they could never be saved. Afterwards the device is back at sign-up with "You left Stadium 2" and its name filled in.
  - **Judge here myself:** an action in a stadium card's menu makes the organizer that stadium's judge, with "Stop judging here" to undo it. It takes the stadium's one place, and reads "Judge: you".
  - **The organizer's own pad** (`/tournaments/<id>/matches/<matchId>`) still opens any match, to score or correct.
- **No judge, no start.** A match that was called can't be started while its stadium has no judge: an approved tablet or the organizer. Approved is enough; a tablet that is offline still counts, because the pad works offline. Calls and on-deck placement are unaffected. The stadium card shows "Awaiting judge..." (or "Judge Asking for Approval" while a tablet has asked for it) and disables Start match.
- **Start is explicit.** A called match's pad shows a large "Start match" button and keeps the finish, draw and launch-error buttons locked until it is pressed. The first tap no longer starts a match. The control room keeps its own Start match, under the same rule.
  - **Start is a pad operation** (`{ op: "start" }`, next to add and void), so it is idempotent, ordered with the taps, and works offline: the outbox unlocks scoring at once and sends the start with the taps later. A start the server refuses locks the pad again and shows the reason.
  - **Scoring from the queue is unchanged:** the organizer can still score a match that isn't at any stadium; no stadium is involved, so no judge is needed.
- **Pad endpoints** (`/api/matches/<id>/battles` and `/result`) accept the organizer's session or the cookie of the judge whose stadium the match is at (`padActor` in `lib/pad.ts`). The service worker caches judge pads (`/t/<slug>/judge/<matchId>`) like the organizer's.
- **Wording:** on-screen messages say "device" for a judge's hardware, and the stadium menu's action is "Disconnect judge pad" (the organizer's wording). The stadium menu's other labels are short: "Hold", "Remove". An on-deck match under a busy stadium says "Called automatically when this stadium is free." only while Call automatically is on.
- **Known limits:**
  - When the organizer disconnects a judge mid-match (rather than the judge leaving), the match stays as it is, but taps still unsent on that device sync only if it is approved again for the same stadium.
  - A judge's pad that is open when the organizer presses Start in the control room still shows its own Start button until it is pressed or the page is reloaded; pressing it does nothing harmful.
  - The judge's waiting screen needs a connection; only the pad itself works offline.
- **Verified in a real browser:** `tests/e2e/judges.e2e.mjs` (61 checks), run by `npm run test:e2e`.

**Light mode in the control room, and the rule dropdowns (2026-10-12).** Reported by the organizer: with Light selected, the control room stayed dark and the Rule profile dropdown's list was unreadable. Each choice below was confirmed before building.

- **The control room follows the theme switch**, like the other organizer pages. This reverses the earlier "always dark" choice for that page; its layout no longer forces the `dark` class. The venue screens (judge pad, call board, player page, judge sign-up) stay dark whatever is selected.
- **Why the dropdown was unreadable:** it was a native `<select>` inside a dark-forced page under a light root. The browser drew its list in the root's light scheme while the text kept the dark theme's pale colour. Menus and tooltips, which render outside the page's wrapper, had the same mismatch.
- **Rule dropdowns use the shadcn Select** (`components/ui/select.tsx`, `@radix-ui/react-select`): "Use these rules" on the control room's Rule profile card, and both "Sets" fields on the rule profile form. They still post their value with the form.
- **A second accent for text** (`--primary-text`, Tailwind `text-primary-text` / `border-primary-text`): lime in dark mode, a dark green of the same hue in light mode (6.1:1 on white). Lime itself can't be read as text on white. Used for "WANTS ACCESS" / "WANTS TO JUDGE", the Rule profile Edit link, the Recall button's text and outline, the highlighted request cards, hover outlines, and the button `link` variant. Filled lime buttons are unchanged.
- **Finish chips** on the Rule profile card keep their hues but use a darker shade on a tinted chip in light mode; the pastel shades remain for dark.
- **`color-scheme`** is now set with the theme tokens (`:root` light, `.dark` dark), so native controls, pop-up lists and scrollbars match, including on the always-dark venue screens under a light root.
- **Checked first:** every organizer page was opened in light mode in a real browser. Sign-in, Tournaments, Rule profiles, the profile form, Challonge connection, the side navigation and the passcode slips needed no change.
- **Verified in a real browser:** `tests/e2e/theme.e2e.mjs` (20 checks), run by `npm run test:e2e`. It measures text contrast against its background for the accent text, chips, menus and dropdown lists in both themes.

**Supported formats and the import review (2026-10-13).** Asked by the organizer: does BXQ work with every Challonge tournament type? It didn't, and nothing stopped an unsupported one from being imported. Each choice below was confirmed before building.

- **What the check found.** Challonge v2.1 has five types: single elimination, double elimination, round robin, Swiss and free for all. Every spike, fixture and the fake Challonge are a double-elimination bracket; single elimination is the same bracket without a losers side.
  - **Round robin and Swiss** were allowed for in the queue planner but never run against the API: spike S4's question about `rank` and `advancing` in those formats has no answer above. `roundLabel` calls their last round "Final" (in Swiss, whichever round is newest), and the correction check's fallback would warn about later matches that a round robin correction doesn't erase.
  - **Free for all** has matches of up to 8 players (`free_for_all_options.max_participants`, and Update Match takes 2 to 8 entries). `playersOf` reads the first two, and the pad, the queue and the scoring engine are one player against one.
  - **Two-stage** tournaments (`group_stage_enabled`) put two brackets in one match list, with round numbers and identifiers that repeat, and the documented `change_state` has no action to end a group stage.
- **Single and double elimination only.** `formatSupport` in `lib/challonge/support.ts` refuses the other three types, any tournament with a group stage, and any type it doesn't know, each with a reason written for the organizer. Round robin and Swiss stay refused until BXQ is adapted to them; spike S7, below, says what that takes.
- **Import asks first.** A dialog shows the tournament's name, format, grand finals (double elimination) or third-place match (single elimination), player count, status and a link to it on Challonge. A tournament in a refused format never reaches it.
  - **By link or ID:** Review reads the tournament (1 request); Import reads the participants and matches (2 more). The fields an import stores travel through the browser in a token signed with `signPayload`, tied to the organizer and valid for 10 minutes (`lib/challonge/import-review.ts`), so the tournament isn't read twice and the format can't be changed on the way.
  - **From "Show my Challonge tournaments":** the dialog opens from what the list already returned, without a request, and Import is the full 3. A refused format shows "Not supported yet" and its reason in place of the Import button.
  - **The link field keeps its text** after a review, so a typo can be fixed and a closed review reopened.
- **Requests:** none added. An import is still 3. A review that is cancelled or refused costs 1; a refused import or resync costs 1, where a resync cost 2.
- **Resync and Finalize refuse** a tournament whose format became unsupported on challonge.com. The stored bracket is left alone; `tournament_type` and the new `tournaments.group_stage` column (migration `0012_group_stage`) are recorded, and BXQ Desk shows a banner with the reason.
- **Checked against the real API afterwards (spike S6, 2026-10-13, 17 requests).** `spikes/s6-formats.mjs` created two private `[SPIKE]` tournaments of 8 players through the API, started them, read them and read the tournament list.
  - **Create Tournament works** with `data.type: "Tournaments"`. A name can be 60 characters at most. A tournament that is underway can't be deleted (422): it has to be reset to `pending` first.
  - **The tournament list carries the options.** Each item has `group_stage_enabled`, `match_options` and, on double elimination, `double_elimination_options`, the same as a single tournament. So a two-stage tournament is refused in the list, before the dialog, and the dialog opened from the list has its option lines.
  - **A third-place match** shows as `match_options.consolation_matches_target_rank: 3`. `third_place_match`, the name in the docs, isn't in the response. The match has the identifier `3P`, **round 0**, and the last `suggested_play_order`, after the final.
  - **Grand finals set to None** (`grand_finals_modifier: "skip"`) is stored and returned, but the started bracket still lists two matches in the last round, as a bracket with a grand-finals reset does. What Challonge does when play reaches them wasn't tested.
  - **A single tournament response includes its matches and participants** in `included` (8 and 8 here; 31 and 16 in the first fixture). An import could ask for less than it does. Not pursued.
- **Known limits:**
  - Results can still be sent for a tournament imported before formats were checked; only the banner, Resync and Finalize react.
  - A third-place match was labelled "Round 0". `roundLabel` now calls round 0 of a single elimination bracket "Third place". The match is still queued after the final, as Challonge orders it, and it doesn't get the finals rules. Further consolation matches (a target rank above 3) weren't looked at.
  - With grand finals set to None, the dialog says "Grand finals: None" while the bracket that is imported still has the two last-round matches. It isn't known whether Challonge ever opens them.
- **Verified:** unit tests for the format check, the preview and the review token; integration tests for a refused import, a reviewed import in 3 requests, a token used by another organizer, and a refused resync and finalize. The dialog, the list and the banner were checked once in a real browser (32 checks, dark and light) against a server whose Challonge calls were answered from the fixtures. That check is not part of `npm run test:e2e`, which has no way to stand in for Challonge.

**Round robin and Swiss against the real API (spike S7, 2026-10-13, 41 requests).** `spikes/s7-round-robin-swiss.mjs` created three private `[SPIKE]` tournaments through the API, played two of them to the end and deleted all three. It answers spike S4's open question about these formats. BXQ still refuses both; the findings say what would have to change first.

- **Creating them:** an options object has to be complete, or the create is refused (422). `round_robin_options` needs `ranking`. `swiss_options` needs every points field, including `pts_for_bye`, which the docs don't list.
- **Results work as BXQ sends them.** In both formats, `rank` 1 and `advancing` for the winner complete the match with the expected `winner_id`, so the check in `report.ts` holds.
- **Round robin (4 players):**
  - Every match is open from the start, in rounds 1 to 3, with a `suggested_play_order` that follows the rounds.
  - A tie is accepted: the match is `complete` with `tie: true`, `winner_id: null` and scores `3 - 3`. BXQ never sends one, but it can meet one entered on challonge.com.
  - A correction changes that match and nothing else.
  - Finalize works and gives every participant a `final_rank`.
- **Swiss (5 players, 2 rounds):**
  - Only round 1 exists at the start. The player without an opponent gets no match at all.
  - Round 2 appears by itself in the match list once the last result of round 1 is in.
  - A round 1 result corrected after round 2 was paired changes that match only. Round 2 keeps its pairings, even though they no longer follow from the results.
  - Finalize works after the last round.
- **Large brackets:** a 16-player round robin has 120 matches, all open at the start. One list request with `per_page=500` returned all 120, with `links.next` null, and the single tournament response included all 120 too. Until now the most seen in one response was 31.
- **No standings before finalize.** A participant has `final_rank` and `tie_break_points`, but no wins, losses or points. A running table would have to be worked out from the matches.
- **What BXQ would need before allowing them:**
  - `roundLabel` must stop calling the last round "Final" outside elimination brackets.
  - The correction check must not warn in these formats, because nothing is erased. In Swiss, `learnProgression` would also mistake the players' arrival in the next round's matches for bracket links.
  - A completed match without a winner (a tie) needs checking on every screen.
  - The refresh after every result is wasted in round robin, where nothing else changes: 16 players cost about 250 requests with it and about 130 without.
- **Not tested here:** a tie in Swiss, a player dropping out of a Swiss tournament and a round robin with two iterations, which spike S8 below covers, and two-stage tournaments.

**What S7 left untested (spike S8, 2026-10-13, 21 requests).** `spikes/s8-drops-ties-iterations.mjs` created two more private `[SPIKE]` tournaments through the API and deleted them.

- **A tie in Swiss** is accepted like one in round robin (`complete`, `tie: true`, no `winner_id`), and the next round is still paired.
- **A player who drops out of a Swiss tournament** (6 players, 3 rounds; dropped after round 1, with a round 2 match still to play):
  - `DELETE /tournaments/{id}/participants/{id}` on a tournament that is underway answers 200 and deactivates the player: `states.active` becomes false. The player isn't removed.
  - `participants_count` stays the same. `resyncTournament` reads the participants again only when that count changes, so it would not notice the drop.
  - Their open match is completed at once as a forfeit: the opponent is the winner and the scores stay `0 - 0`. A match can therefore finish without BXQ having reported it.
  - **Round 3 was not in the match list** read right after the last round 2 result, although `swiss_options.rounds` was 3. In S7, without a drop, the next round was there at once. Whether a drop stops Challonge from pairing the next round or only delays it wasn't settled: the tournament had been deleted before this was noticed. Spike S9 below looked into it.
- **A round robin with an odd number of players, played twice** (3 players, 2 iterations): 6 matches in rounds 1 to 6, one match a round, all open from the start. The player who sits out gets no match. The second iteration continues the round numbers and swaps the players' sides; nothing else marks it.
- **Added to what BXQ would need before allowing these formats:** a resync has to notice a dropped player without a change in `participants_count`, and what happens to the later rounds after a drop has to be settled.
- **Still not tested:** two-stage tournaments.

**Swiss rounds after a drop (spike S9, 2026-10-13, 20 requests).** `spikes/s9-swiss-rounds-after-drop.mjs` played a 6-player Swiss of 4 rounds: two rounds with nobody dropped, as a control, then a drop during round 3.

- **Without a drop,** rounds 2 and 3 were each in the match list right after the round before them ended.
- **After the drop,** the player's round 3 match was forfeited as in S8, and **round 4 was paired at once**: two matches among the five players left. The dropped player wasn't paired, and one player had no match. A second read 20 seconds later showed the same.
- **So a drop by itself doesn't stop the pairing,** and the round that was missing in S8 is unexplained. S8 differed in two ways: it had a tie in round 1, and its missing round was the last of 3. Which of the two mattered, or whether that round was only late, isn't known.
- The tournament stayed `underway`, with `participants_count` still 6 and the dropped player `active: false`.

**Why S8's round was missing (spikes S10 and S11, 2026-10-13, 34 requests).**

- **Not the tie, and not the drop.** `spikes/s10-swiss-missing-round.mjs` replayed S8 exactly: the same tie in round 1 and the same player dropped in round 2. This time round 3 was in the first read. The same steps gave both outcomes.
- **Challonge pairs the next round after it has answered the result request, not inside it.** The saved responses show it. Each result request reports how long it ran on the server (`x-runtime`), and each new match has a `created_at`:

  | Round change | The result request ran on the server | The next round was created, counted from the result being saved |
  |---|---|---|
  | S8, round 1 to 2 | 77 ms | 131 to 303 ms |
  | S10, round 1 to 2 | 76 ms | 199 to 297 ms |
  | S9, round 2 to 3 | 115 ms | 132 to 194 ms |
  | S10, round 2 to 3 | 46 ms | 58 to 87 ms |

  In these four the request had already finished when the round was created. In the other four that were measured, the round came 25 to 113 ms after the result was saved.
- **A read sent straight after the result usually arrives late enough.** From this machine a request takes about 300 ms to travel to Challonge and back, so each read reached Challonge about 300 to 330 ms after the result request had finished there. The pairing took up to about 300 ms. In S8 it was slower than that once, and the read came first.
- **S11** (`spikes/s11-swiss-pairing-race.mjs`) tried to catch the gap on purpose, with reads sent 150, 250 and 350 ms after the last result of a round, and one when it returned. All eight saw the next round. Challonge answered them late, 0.7 to 2.7 seconds after the result was sent: reads sent beside a result don't overtake it.
- **Not observed:** one tournament with the round missing and then there. S8's tournament was deleted before a second read, and the gap didn't open again in seven more round changes.
- **What it means for BXQ:** the refresh after a result can't be relied on to contain the next Swiss round. A server close to Challonge reads sooner than this machine does, so it would miss the round more often. Supporting Swiss needs a second read when a round's last result brings no new matches, at the cost of a request.
- **The same question for the formats BXQ already runs:** does an elimination bracket move the winner and the loser into their next matches inside the result request or after it? Spike S4 saw them in the refresh, but from this machine and its 300 ms. Spike S12, below, measures it.

**In an elimination bracket the next matches change within the result request, in all five results measured (spikes S12 and S13, 2026-10-13, 23 requests).** `spikes/s12-elimination-progression-timing.mjs` reported the two first-round matches of a 4-player double elimination bracket and read the bracket once. `spikes/s13-elimination-progression-samples.mjs` reported the four first-round matches of an 8-player bracket, with a read after each.

| Result | The request ran on the server | The winner's and the loser's next match were updated, counted from the result being saved |
|---|---|---|
| S12, second of 4 players' first round | 443 ms | 50 and 113 ms (both opened) |
| S13, match A | 184 ms | 34 and 41 ms (one slot filled in each) |
| S13, match B | 152 ms | 11 and 21 ms (both opened) |
| S13, match C | 108 ms | 11 and 17 ms (one slot filled in each) |
| S13, match D | 197 ms | 16 and 56 ms (both opened) |

- Every change falls well within its request, at a third of its length or less. Filling one slot of a match updates that match's `updated_at`, as opening it does.
- In Swiss it was the other way round: the next round was created 58 to 303 ms after the result was saved, after result requests of 46 to 115 ms had already finished.
- **It is strong evidence, not proof.** The figures would also fit a result saved in the last moments of each of the five requests. A result whose next matches changed later than its request ran would show the opposite; none has been seen.
- **For BXQ:** nothing here suggests that the refresh after a result misses the next matches of a single or double elimination bracket.

**What was still unknown in the formats BXQ runs (spikes S14 to S16, 2026-10-13, 45 requests).**

- **Grand finals set to None (S14, 14 requests).** A 4-player bracket was played through the API up to its last round. The first last-round match received both finalists and stayed `pending`; the second stayed empty. Challonge finalized the tournament like that, with the winners-bracket winner first and the losers-bracket winner second.
  - BXQ already copes: a pending match is never queued, the finalize check counts only open matches, and the round labels are right because the last round is still in the bracket.
  - A profile's finals rules then apply to no match that is played, since BXQ's finals are the last round.
- **Consolation matches beyond third place (S15, 6 requests).** `consolation_matches_target_rank: 7` on an 8-player single elimination bracket adds five matches, all in round 0 and all after the final in `suggested_play_order`: `5PQ1`, `5PQ2`, `5P`, `7P` and, last, `3P`. `roundLabel` called every round 0 match "Third place", which was wrong for the other four. It now takes the match's identifier and names them "Fifth place qualifier", "Fifth place", "Seventh place" and "Third place"; a round 0 match it can't place is a "Placement match".
- **A whole event through BXQ (S16, 25 requests: 19 made by BXQ, 6 directly).** `spikes/s16-full-event-through-bxq.mjs` created a 4-player double elimination tournament on Challonge and drove the app in a real browser as an organizer: import through the review dialog, one stadium with "Judge here myself", all six matches scored on the pad and sent, and Finalize. All 16 checks passed.
  - **BXQ's own request count matched the cost tables:** 1 to review, 2 to import, 2 for each result, 4 to finalize.
  - **Read back from Challonge,** the tournament was `complete`, and every match's state, winner and score and every placement equalled what BXQ had stored.
  - **The reset match was removed, not left pending.** When the winners-side finalist won the first grand-finals match, the second one disappeared from Challonge's bracket. The comment in `lib/finalize-check.ts` describes a match left pending; that is what a bracket without grand finals does (S14).
  - **This is the first real finalize from BXQ.** Not covered by the run: a correction, a result sent from a judge's tablet or after being offline, a grand-finals reset that is played, and the board and the Pass after finalizing.

**Round robin (2026-10-14).** The organizer decided to support round robin and Swiss, round robin first. Each choice below was confirmed before building.

- **Imported like a bracket.** `formatSupport` now accepts round robin; Swiss, free for all and two-stage tournaments stay refused. The review dialog adds "Plays each opponent: Once" or "Twice", from `round_robin_options.iterations`.
- **`isElimination` in `lib/challonge/support.ts`** is the one place that says whether a format is a bracket. Three things follow from it.
  - **A result is 1 request, not 2.** Spike S7 showed that a round robin result changes that match and nothing else, so `report.ts` updates the match from Challonge's answer and doesn't read the matches again. The check that Challonge applied the result is unchanged. Chosen over refreshing every time: 16 players cost about 130 requests this way and about 250 the other, and more than 22 players would pass 500.
  - **A corrected winner isn't asked about,** because nothing is erased. In a bracket the fallback of the correction check would have listed later matches of either player.
  - **No round is a final.** `roundLabel` returns "Round N" for every round; `isFinalsMatch` already applied only to brackets, so a profile's finals rules aren't used.
- **Ties.** The pad still never sends one. A match that is complete without a winner, which is how a tie entered on challonge.com arrives, reads "Tie" on the Desk and "Tied" on the Pass; it was blank on the Desk and "Played" on the Pass.
- **The Desk's "Waiting to sync" card** says "one request each" for a round robin.
- **Left out on purpose:** running standings (Challonge gives none before finalize; placements appear after it, as in a bracket) and an estimate of requests in the review dialog.
- **Known limits:**
  - Something changed on challonge.com during a round robin reaches BXQ with the next Resync, since results no longer read the matches.
  - A result BXQ failed to send keeps Finalize blocked until it is sent again from BXQ, even if the match was completed on challonge.com in the meantime. This is true of every format; a test of the round robin met it.
  - The e2e suites have no round robin data. The labels and the "one request each" line were checked in the real run below.
- **Verified:** unit tests for the format check, the labels and the dialog line; integration tests against a fake round robin built from the response S7 recorded (import, a result in 1 request, the queue after it, a correction, a 200 that changed nothing, a tie, finalize); the nine e2e suites. A whole 4-player event then ran through BXQ against the real Challonge (`spikes/s16-full-event-through-bxq.mjs --format=round-robin`): 18 checks passed, BXQ made 13 requests (3 to import, 1 for each of 6 results, 4 to finalize), and Challonge ended with the states, winners, scores and placements BXQ had stored.

**Swiss (2026-10-14).** The second of the two formats the organizer decided to support. Each choice below was confirmed before building.

- **Imported like the others.** `formatSupport` now accepts Swiss; only free for all and two-stage tournaments are refused. The review dialog adds "Rounds: 5", from `swiss_options.rounds`.
- **A result is 1 request,** as in round robin: a result changes that match only (spike S7), so the match is updated from Challonge's answer.
- **The next round is read with the last result of a round.** Challonge pairs it after it has answered that result (spikes S10, S11), so `readNextRound` in `report.ts` waits a second, reads the matches, and reads once more two seconds later if no new round is in them: 1 request a round, 2 when it is late. The judge of a round's last match waits that long on "Send to Challonge". Chosen over reading in the background after the response, where a failed read would go unnoticed, and over leaving it to the organizer's Resync.
- **When the round still isn't there,** the pad shows "Round 4 isn't paired there yet. Use Resync in a moment." under the saved result, and nothing else is read.
- **`tournaments.swiss_rounds`** (migration `0013_swiss_rounds`) holds the number of rounds. With it, nothing is read after the last round, and `finalizeBlockers` keeps Finalize off between rounds, when nothing is open but rounds remain: "Round 3 of 5 isn't paired on Challonge yet. Resync in a moment." `finalizeTournament` applies the same check after its resync, so Challonge is never asked to finalize early.
- **A player who drops out** is dropped on challonge.com and picked up by Resync. Challonge keeps a dropped player in `participants_count` (spike S8), so a Swiss resync always reads the participants: 3 requests, not 2, and a Swiss finalize 5, not 4. BXQ then has the player inactive, which takes them off the Pass sign-in list, and their open match complete as Challonge's forfeit. A "Drop player" button on the Desk was left out.
- **Corrections** aren't asked about: nothing is erased, and later rounds keep the pairings Challonge made from the old result.
- **Left out on purpose:** running standings, a "Drop player" button, and a message of their own for a player without an opponent in a round, whose Pass says "No match for you right now."
- **Known limits:**
  - Something changed on challonge.com during a round reaches BXQ with the next Resync or with the read after the round's last result.
  - If a drop on challonge.com forfeits the last open match of a round, BXQ doesn't know the round ended until Resync.
  - The waits before reading the next round are fixed (1 second, then 2). They cover every measurement so far, with room, but they are measurements from one day.
  - A tie in a Swiss tournament was seen in spikes S8 and S10, not in a run through BXQ.
- **Verified:** unit tests for the format check, the dialog line and the finalize check; integration tests against a fake Swiss tournament built from the response S10 recorded, which pairs each next round itself and can hide it from the first reads (import, results, a round read with the last result, a second read for a late round, a round that stays missing with Finalize refused and nothing sent, a correction, a drop, finalize in 5 requests); the nine e2e suites. A whole 5-player, 3-round event then ran through BXQ against the real Challonge (`spikes/s16-full-event-through-bxq.mjs --format=swiss`), with a player dropped through the API during round 2 and picked up by Resync: 17 checks passed, both next rounds were there at the first read, BXQ made 18 requests (3 to import, 1 for each of 5 results, 1 for each of 2 round reads, 3 for the Resync, 5 to finalize), and Challonge ended with the states, winners, scores and placements BXQ had stored.

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
