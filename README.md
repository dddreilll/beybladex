# BXQ

**Your stadium is ready.**

BXQ is an open-source web app for running Beyblade X tournaments on top of [Challonge](https://challonge.com). The organizer calls players to stadiums, judges score battles finish by finish, and the Challonge bracket stays in sync.

The name joins "BX", Takara Tomy's product line code for Beyblade X, and "Q" for queue.

| Document | What it covers |
|---|---|
| [docs/PRD.md](docs/PRD.md) | What BXQ is for, who uses it, and what each milestone delivered |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it is built today |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Colours, type, components, and the patterns of each screen |
| [docs/brand.md](docs/brand.md) | The name, the tone and the screen names |
| [docs/rfc-001-architecture.md](docs/rfc-001-architecture.md) | The decisions, the Challonge API findings, and the record of each milestone |
| [AGENTS.md](AGENTS.md) | The rules for AI coding agents working in this repository |

## The four screens

| Screen | For | Where | What it does |
|---|---|---|---|
| **BXQ Desk** | Organizers | `/tournaments/<id>` | The floor dashboard: stadium cards, the queue, automatic or manual on deck, recalls, device banners, passcodes and slip printing. |
| **BXQ Board** | Spectators and the floor | `/t/<slug>/board`, short link `/b/<code>` | A TV display the organizer approves by pairing code. Chimes and spoken calls, live scores, "In the hole", a QR code, and the final standings once the tournament is finalized. |
| **BXQ Pad** | Judges | `/j/<code>` to sign up | Tablet-first, always dark scoring that keeps working offline. A judge pairs with a short code and the organizer approves; no organizer sign-in on the tablet. |
| **BXQ Pass** | Players | `/t/<slug>` | An installable page with push alerts ("On deck", "You're up"). Opened with a 4-digit passcode or the QR code on a personal slip, and shows only that player's matches, placement and scores. |

Boards, pads and player phones only ever talk to BXQ's own server, so the whole event fits inside Challonge's free 500 requests a month.

## Status: milestone M1

| Feature | Notes |
|---|---|
| Magic-link sign-in for organizers | Supabase Auth |
| Bring-your-own Challonge OAuth app per organizer | Client secret and tokens are encrypted at rest with AES-256-GCM. Refresh is automatic and locked against concurrent use, because Challonge rotates refresh tokens. |
| Tournament import | 3 Challonge requests. Since the import review (below), you check the tournament in a dialog first, and only single elimination, double elimination, round robin, Swiss and two-stage tournaments (groups of any of those four, then a bracket) are imported. |
| Resync | 2 requests when nothing changed, using an ETag/304 check (3 in Swiss and in a two-stage tournament, see below) |
| Read-only BXQ Desk | Ready-to-call matches in Challonge's suggested play order, matches waiting for an opponent, and completed results |
| Per-organizer request budget meter | The app counts every request itself, including 304s and token calls |

**M2 adds:**

| Feature | Notes |
|---|---|
| Rule profiles | 4 presets plus your own: points per finish, target, best-of sets, finals override, launch-error penalty, own finish, and capped scores |
| BXQ Pad | Tablet-first, forced dark. Taps are saved per battle, idempotent, and retried. Undo and draw. Keeps the screen awake. Since the judge tablets change, a called match has to be started on the pad first. |
| Sending results to Challonge | 2 requests per result (1 in a round robin, in Swiss and in a round robin or Swiss group of a two-stage tournament, see below). It checks that Challonge really applied the result, then refreshes the bracket. |
| Corrections | Warns and asks for confirmation before erasing matches that were already played. Failed sends can be retried from the Desk. |

**M3 adds:**

| Feature | Notes |
|---|---|
| Stadium lanes on the Desk | Now and On deck for each stadium. Auto-call when a stadium frees up. Call / Start / No-show hold. Add, rename and remove stadiums. |
| BXQ Board at `/t/<slug>/board` | For a TV (since M6, after you approve the screen). Shows "Now calling", live scores, "In the hole" and a QR code. Calls are announced with a chime and spoken aloud. |
| BXQ Pass at `/t/<slug>` | Players pick their name (since M6, and enter their passcode) and see whether they're called, on deck, queued or waiting. It updates live. |

**Live updates:** the board, the Pass and the Desk poll our own server, using a version ETag. They never call Challonge. The board and the Desk also listen on Supabase Realtime: a database trigger announces each change, they fetch at once, and their polling drops to a check every 60 seconds while that connection is up. Player phones poll every 10 seconds and rely on push notifications for the call itself. When testing with phones on the venue Wi-Fi, set `APP_URL` to your laptop's LAN address (e.g. `http://192.168.1.10:3000`) so the QR code works.

**M4 adds:**

| Feature | Notes |
|---|---|
| Web push for players | "On deck at Stadium 2", then "You're up at Stadium 2", even when the page is closed. Players opt in on their Pass. |
| Installable BXQ Pass | Each tournament has its own manifest, so "Add to Home Screen" opens that tournament's Pass. On iPhone, notifications only work after this step. |

**Testing push locally:**

1. Open BXQ Pass (`/t/<slug>`) in Chrome or Edge on `http://localhost:3000`.
2. Pick a player, enter their passcode (listed under **Players and passcodes** on the Desk) and click **Enable notifications**.
3. Call that player's match from the Desk.

Phones need HTTPS (for example a tunnel or a deployed URL).

**M5 adds:**

| Feature | Notes |
|---|---|
| Offline BXQ Pad | Taps are stored on the device (IndexedDB) and sync in the background. A lost connection, a reload or a crashed tab loses nothing. |
| Offline results | A match finished offline is sent to Challonge automatically when the connection returns. |
| Pads that open offline | Pads are cached by a service worker, and the Desk pre-loads the pads of matches at stadiums. |
| Device banner | The Desk lists anything still only on this device, and why. |

All five milestones in the RFC are now built.

**After M5: Desk redesign and queue controls**

| Feature | Notes |
|---|---|
| Desk layout | Matches the mockup: header row, stadium cards with live scores, queue table, sidebar. No app navigation on this page. |
| Recall players | Re-announces a called match as "Second call", "Third call" and so on: chime and voice on the board, plus another push. 15-second cooldown. |
| Manual or automatic on deck | A "Fill on deck automatically" switch, separate from "Call automatically". With it off, you place matches from the queue. |
| Back to queue | Sends an on-deck match back; the next ready match takes its slot. |
| Hold / Cancel a match in progress | Hold keeps the recorded battles. Cancel voids them and restarts the match at 0–0. Both leave the match HELD until you release it. |

**M6 adds:**

| Feature | Notes |
|---|---|
| Finalize tournament | A button on the Desk, available once every match is played and sent. About 4 Challonge requests; can't be undone on Challonge. The board then shows the final standings and each player sees their placement on their Pass. |
| Boards need approval | A screen opening `/t/<slug>/board` shows a pairing code until you approve it on the Desk. A limit per tournament (default 1, in Venue settings), a live count of open boards, and Disconnect. |
| Player passcodes | Each player signs in with a 4-digit passcode, or by scanning the personal QR code on their slip, on one device at a time. Signing in elsewhere moves them. The Desk lists passcodes, issues new ones and prints the slips. |
| Players see only their own match | The Pass no longer links to the board, and the server sends each phone just that player's match. |

**After M6: battle scores of finished matches**

| Feature | Notes |
|---|---|
| View battles (Desk) | Each finished match opens a dialog with every battle: who scored, the finish, the points and the running score. A switch also shows battles the judge undid, or that a cancel or correction wiped. |
| Your matches (Pass) | A player sees their own finished matches and can open each one's battle-by-battle score. Nothing about other players' matches, and nothing that was undone. |

**After M6: short links, judge tablets, no judge no start**

| Feature | Notes |
|---|---|
| Short links | Each tournament has a 6-character code: `/b/<code>` opens BXQ Board and `/j/<code>` the BXQ Pad sign-up. The Desk shows both; clicking one copies it. |
| Judge tablets | A judge opens the judge link, picks a stadium, and you approve the tablet on the Desk. No organizer sign-in on the tablet; it can only score the match at its stadium, and follows that stadium from match to match. One judge per stadium. |
| Judge here myself | In a stadium card's menu: makes you its judge, for running an event alone. |
| Leaving a stadium | A judge can leave their stadium from their own screen. With a match there it asks first; the score is kept and the next judge carries on from it. |
| Judge names | A judge starts with their device's name and can change it on the tablet; you can rename them from the stadium's menu. |
| No judge, no start | A called match can't start until its stadium has a judge. Calls still go out. |
| Start match on the pad | A called match is locked on the pad until Start match is pressed (also offline). The Desk keeps its own Start match. |

**After M6: landing page**

| Feature | Notes |
|---|---|
| Landing page at `/` | For organizers who aren't signed in: a megaphone-and-paper tournament day next to one run with BXQ, the flow from a tap on the pad to the call on the board, and the four screens. Signed-in organizers see it too: for them the header link and the main buttons read "Go to Dashboard" and lead to their tournaments. |
| Animated preview | Beside the headline, an 8-second loop of one match: the judge taps Burst on the pad, the result is sent to Challonge, the next player gets "You're up", and the board calls the match. It is a [Remotion](https://www.remotion.dev) composition drawn in code from the app's own colours, with made-up names, and rendered as DOM by `@remotion/player`. The player loads after the page has rendered; until then, and for people who ask for reduced motion, a still of the board is shown. To a screen reader it is one described image. |
| Request Early Access | The button in the hero and at the end of the page opens `EARLY_ACCESS_URL` (a form or chat link) in a new tab. Without that variable the button is disabled. Organizers who already have access use "Organizer sign in" in the header. |
| FAQ | Six questions organizers ask, each answer closed until its question is clicked: who can use BXQ, Challonge, what the venue needs, Wi-Fi drops, players' apps and accounts, and player data. |
| Terms of Service and Privacy Policy | `/terms` and `/privacy`, open without signing in and linked from the landing page's footer. They name the operator from `OPERATOR_NAME` and give `CONTACT_EMAIL` as the contact; without them they say "the operator of this site" and give no address. The terms are under Philippine law, and the policy lists what the app really stores (keep it in step with `lib/db/schema.ts`). Both are drafts written with the app, not legal advice: have them reviewed before relying on them. |
| Agreeing to them | "By continuing, you agree to our Terms of Service and Privacy Policy" sits under the organizer sign-in card and under "Open my Pass" on a player's passcode screen. A player who scans the QR code on their slip is signed in directly and doesn't pass that line. |
| Invite-only sign-in | Sign-ups are off in Supabase (`enable_signup = false` in `supabase/config.toml`; "Allow new users to sign up" in a hosted project), so a sign-in link goes only to an email that was invited. `npm run invite -- <email>` sends the invite, which signs the organizer in through `/auth/confirm`; after that they use the sign-in form as before. Anyone else is told "This email doesn't have access yet", with Request Early Access when it is set. |
| Share preview | `/opengraph-image` is drawn in code and served without signing in, so a shared link shows a preview. |

**After M6: import review and supported formats**

| Feature | Notes |
|---|---|
| Review before importing | Importing asks first, in a dialog with the tournament's name, format, grand finals or third-place match, player count, status and a link to it on Challonge. By link or ID, **Review** reads the tournament (1 request) and **Import** reads the rest (2 more), so an import is still 3 requests. From "Show my Challonge tournaments" the details are already on the page: the dialog opens at no cost and Import uses 3. |
| Supported formats | Single elimination, double elimination and, since the work below, round robin and Swiss. Two-stage tournaments (a group stage, then a final stage) came after that, and are described further down. Free for all never reaches the review. By link or ID you get the reason after the 1 request that read it; in the list the row says "Not supported yet" and has no Import button. |
| A format that changes later | If a tournament you already imported becomes one BXQ doesn't run, Resync and Finalize refuse after 1 request and leave its bracket as it was. A banner on the Desk says why. |

**After M6: round robin**

| Feature | Notes |
|---|---|
| Round robin tournaments | Imported like a bracket; the review dialog also says how often each pair of players meets. Every match is ready from the start, so the queue runs through the rounds in order and skips players who are already at a stadium. Rounds are "Round 1", "Round 2" and so on: there is no final, and a rule profile's finals rules aren't used. |
| One request per result | A round robin result changes that match and nothing else, so BXQ doesn't read the bracket again: 1 request per result, about 130 for 16 players (120 matches). Something changed on challonge.com shows after Resync. |
| Corrections without a warning | Changing a winner erases nothing in a round robin, so the pad doesn't ask first. |
| Ties | The pad never sends a tie: a draw is replayed. One entered on challonge.com shows as "Tie" on the Desk and "Tied" on the player's Pass. |
| No running standings | Placements appear after you finalize, as in a bracket. The table while the event runs is on challonge.com. |

**After M6: Swiss**

| Feature | Notes |
|---|---|
| Swiss tournaments | Imported like a bracket; the review dialog also gives the number of rounds. Challonge pairs one round at a time, so BXQ holds only the rounds paired so far. Rounds are "Round 1", "Round 2" and so on, corrections need no warning, and ties show as in a round robin. |
| One request per result, one per round | A result changes that match only: 1 request. After the last result of a round BXQ reads the next round: 1 more request. Challonge pairs that round a moment after answering the result, so BXQ waits a second before reading, and reads once more two seconds later if the round isn't there yet. The judge of a round's last match waits that long on "Send to Challonge". 32 players over 5 rounds come to about 95 requests. |
| A round that is late | If the next round still isn't on Challonge after the second read, the pad says so, and the Desk keeps Finalize off with "Round 3 of 5 isn't paired on Challonge yet. Resync in a moment." |
| Finalize waits for the last round | BXQ keeps the number of rounds, so Finalize isn't offered between rounds, when nothing is open but rounds remain. |
| A player who drops out | Drop them on challonge.com, then press Resync. In Swiss a Resync always reads the players as well (3 requests, not 2), because a dropped player stays in Challonge's count. BXQ then has the player inactive, off the Pass sign-in list, and their open match forfeited to the opponent. |
| A player without an opponent | With an odd number of players, one has no match in a round. Their Pass says "No match for you right now." |

**After M6: two-stage tournaments**

| Feature | Notes |
|---|---|
| Two-stage tournaments | A group stage, then a final stage. The groups and the final stage can each be round robin, Swiss, single elimination or double elimination (a round robin or Swiss final stage since the section after this one). The review dialog shows the groups ("Round robin, groups of 4, top 2 advance") and the format of the final stage. |
| Groups on every screen | A group match reads "Group A · Round 2" on the Desk, the board, the pad, the Pass and in notifications. Challonge doesn't say which group a match is in, so BXQ works it out. Where it can't, and where there is one group, the match reads "Group stage · Round 2". The queue takes the groups in turn: every group's first match, then every second one. |
| One request per result in a round robin or Swiss group | As in a round robin or Swiss tournament. In Swiss groups, BXQ reads a group's next round after the last result of that group's round (1 request, 2 if the round is late). Challonge doesn't say how many rounds a group has, so after a group's last round both reads find nothing. |
| Groups that are brackets | A single or double elimination group is played until as many players are left as advance. Challonge never opens the match between them (the group's final, or its grand final), so it is never queued, and the group stage can end without it. A result costs 2 requests, as in any bracket, because it moves players on within the group. Rounds read "Group A · Winners R1" or "Group A · Losers Final", and a corrected winner asks first if it would erase a later result of the group. |
| End group stage | A button on the Desk where Finalize otherwise is, available once every group match is played and sent. 2 requests. Challonge works out who advances, and the Desk lists them. **Group results can't be corrected after this:** Challonge refuses them, so BXQ says so without sending. |
| Start final stage | The next button, 2 requests. Challonge creates the matches of the final stage and they go to the stadiums. From here the tournament runs as a bracket (2 requests per result), and Finalize is offered at the end. |
| Players who don't advance | They stay on the Pass sign-in list and the passcode slips. Their Pass says they didn't advance, keeps their results, and shows their placement after Finalize. |
| Resync and Finalize | A Resync always reads the players too (3 requests), because the end of the group stage changes their seeds and not their number. Finalize is 5 requests. |
| What an event costs | 16 players in 4 round robin groups of 4, the top 2 of each into an 8-player single elimination bracket: about 50 requests. With single elimination groups, which have fewer matches: about 42. |

**After M6: standings, round robin and Swiss final stages, and venue fixes**

| Feature | Notes |
|---|---|
| Standings | A round robin, Swiss, every group of a two-stage tournament, and a round robin or Swiss final stage get running standings by record: wins and losses, a tie on challonge.com counting as half a win. Players with the same record share a place. Worked out from the results BXQ has, so no Challonge request. They are labelled as not official: Challonge decides the placements at Finalize, with its own tie-breaks. |
| Standings on the Desk | Under the Queue, one table for each group. Once the group stage has ended, the players who advanced are marked, and a group's table says "ended" once the final stage has started. |
| Standings on the board | They take turns with "In the hole" in the same place, 15 seconds each, one table at a time. Only the stage being played, once it has a result, and the best 10 of each table. Never on a Pass: a phone gets its own player's data only. |
| Round robin or Swiss final stage | Imported since spike S20 played one of each against the real Challonge. Starting the final stage creates every match of a round robin, or the first round of a Swiss, whose next round Challonge pairs after the last result of a round. A result costs 1 request, a Swiss final stage reads its next round as a Swiss tournament does, and no match gets the finals rules. |
| Move to | An on-deck match can be moved to another stadium whose on-deck slot is empty, with Move to under it on the stadium card. Its players are told the new stadium. |
| A screen that closes | A board, a judge tablet or a Pass says so as its tab closes, and the Desk shows it closed within seconds instead of after 150. A device that dies without closing its tab still counts as open for 150 seconds. |
| Wrong passcodes | 10 wrong tries in 10 minutes lock the device that made them out of that player, not the player's own phone. 60 in an hour, from any devices, lock the player everywhere. The QR code on the passcode slip works all along, and the Pass says so. |

## Stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript
- **UI:** Tailwind CSS with shadcn/ui. The landing page's animation uses Remotion, which is free for individuals and for companies of up to three people; larger companies need a [company licence](https://www.remotion.dev/docs/license).
- **Auth and database:** Supabase for auth and Postgres, with Drizzle ORM. App tables live in a private `app` schema that the Supabase Data API does not expose.
- **Tests:** Vitest, with unit tests plus database integration tests against local Supabase

## Local setup

You need Node 20.6 or later and Docker.

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Start local Supabase** (Postgres, Auth, and Mailpit as a test inbox). The first run pulls Docker images. It uses ports 44321–44324 rather than Supabase's default 5432x, because Windows often reserves that range.
   ```bash
   npm run supabase:start
   ```
3. **Create `.env.local`** from `.env.example`. `npx supabase status` prints the URL and the publishable key. Generate an encryption key with:
   ```bash
   node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"
   ```
4. **Create the tables:**
   ```bash
   npm run db:migrate
   ```
5. **Run the app:**
   ```bash
   npm run dev
   ```
   Sign-in is invite-only, so invite yourself first, then open the invite in Mailpit at http://127.0.0.1:44324:
   ```bash
   npm run invite -- you@example.com
   ```
   After that, sign in at http://localhost:3000/auth/login; the sign-in emails arrive in Mailpit too.
6. **Connect Challonge.** Go to **Challonge connection** in the app:
   1. Create an app at https://connect.challonge.com.
   2. Register the redirect URI the page shows, which is `http://localhost:3000/api/challonge/oauth/callback`.
   3. Paste the app's client ID and secret into the page.
   4. Click **Connect Challonge**.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Unit tests. Also runs the integration tests when `.env.local` points at a database. |
| `npm run test:e2e` | Offline BXQ Pad, the Desk, a two-stage tournament and its standings on the Desk, the board and the Pass, navigation, board and Pass access, battle scores, judge tablets, light and dark mode, the landing page, and invite-only sign-in in a real browser (installed Edge; set `E2E_BROWSER=chrome` for Chrome). Needs local Supabase and `npm run build && npx next start -p 3100`. |
| `npm run typecheck` / `lint` | `tsc` and ESLint |
| `npm run db:generate` | Generate a migration after changing `lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations in `drizzle/` |
| `npm run supabase:start` / `supabase:stop` | Local Supabase |
| `npm run invite -- <email>` | Invite an organizer. Sign-ups are off, so this is how someone gets access. Against a hosted project, set `SUPABASE_SECRET_KEY` for the command. |

## Layout

```
app/
  page.tsx                   landing page (components/landing/); opengraph-image.tsx is its share preview
  terms/ · privacy/          Terms of Service and Privacy Policy (components/legal/)
  auth/                      magic-link login, confirm route, error page
  (organizer)/               signed-in pages; each uses the shared header + side navigation
    settings/challonge/      bring-your-own OAuth app: credentials, connect, remove
    tournaments/             list + import
  (control)/tournaments/[id]/  BXQ Desk (own header, no app navigation)
  (judge)/tournaments/[id]/matches/[matchId]/  the organizer's own BXQ Pad
  t/[slug]/                  BXQ Pass; board/ is BXQ Board, judge/ a judge tablet's BXQ Pad
  b/[code]/ · j/[code]/      short links to BXQ Board and the BXQ Pad sign-up
  api/challonge/oauth/callback/
lib/
  challonge/                 API client, OAuth, connection + token refresh, sync, report, progression, budget
  scoring/                   rule profiles + presets, pure scoring engine
  battles.ts · rules.ts      BXQ Pad ops (idempotent) and rules resolution
  crypto/secrets.ts          AES-256-GCM envelopes + signed OAuth state
  db/                        Drizzle schema + client
  control-room.ts            pure queue builder (unit-tested on real bracket data)
  standings.ts               pure running standings by record, for the Desk and the board
drizzle/                     SQL migrations
tests/                       unit + integration tests, recorded Challonge fixtures
spikes/                      throwaway API spike scripts (see spikes/README.md)
docs/                        PRD, architecture, design system, brand guide, RFC
```

## Deploying

You need a hosted Supabase project and a Node host such as Vercel. Set the same variables as in `.env.example`. Use the project's transaction-pooler URL (port 6543) as `DATABASE_URL`: every server instance keeps its own connections, and the session pooler runs out of them ("max clients reached") once a few instances are warm. Migrations use the same variable.

On Vercel, migrations run by themselves: `vercel.json` runs `scripts/migrate-on-deploy.mjs` before each build, which applies pending migrations for production deploys only and fails the deploy if one fails. On another host, run `npm run db:migrate` against the database before deploying.

Live updates use Supabase Realtime on public channels, which is on by default for a new project. If Realtime is unavailable, screens fall back to polling by themselves.

In the Supabase dashboard, add `https://<your-domain>/**` to **Auth → URL Configuration → Redirect URLs**. To keep sign-in invite-only, turn off **Allow new users to sign up** under Authentication, and paste `supabase/templates/invite.html` into the **Invite user** email template, so the invite link goes through the app's own `/auth/confirm`. Invite organizers from **Authentication → Users**, or with `npm run invite`. Each organizer registers `https://<your-domain>/api/challonge/oauth/callback` on their own Challonge app.
