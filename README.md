# BXQ

**Your stadium is ready.**

BXQ is an open-source web app for running Beyblade X tournaments. It builds the bracket, the organizer calls players to stadiums, judges score battles finish by finish, and the bracket moves on the moment a match ends.

The name joins "BX", Takara Tomy's product line code for Beyblade X, and "Q" for queue.

| Document | What it covers |
|---|---|
| [docs/PRD.md](docs/PRD.md) | What BXQ is for, who uses it, and what each milestone delivered |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it is built today |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Colours, type, components, and the patterns of each screen |
| [docs/brand.md](docs/brand.md) | The name, the tone and the screen names |
| [docs/rfc-002-own-bracket-engine.md](docs/rfc-002-own-bracket-engine.md) | Why BXQ runs its own brackets, the engine's decisions, and the record of each milestone |
| [docs/rfc-001-architecture.md](docs/rfc-001-architecture.md) | History: how BXQ was first built on Challonge (superseded) |
| [AGENTS.md](AGENTS.md) | The rules for AI coding agents working in this repository |

## The four screens

| Screen | For | Where | What it does |
|---|---|---|---|
| **BXQ Desk** | Organizers | `/tournaments/<id>` | Players and seeds before the start; then the floor dashboard: stadium cards, the queue, automatic or manual on deck, recalls, drops, device banners, passcodes and slip printing, and the whole bracket on its own page. |
| **BXQ Board** | Spectators and the floor | `/t/<slug>/board`, short link `/b/<code>` | A TV display the organizer approves by pairing code. Chimes and spoken calls, live scores, "In the hole", a QR code, standings, and the final standings once the tournament is finished. |
| **BXQ Pad** | Judges | `/j/<code>` to sign up | Tablet-first, always dark scoring that keeps working offline. A judge pairs with a short code and the organizer approves; no organizer sign-in on the tablet. |
| **BXQ Pass** | Players | `/t/<slug>` | An installable page with push alerts ("On deck", "You're up"). Opened with a 4-digit passcode or the QR code on a personal slip, and shows only that player's matches, placement and scores. |

Boards, pads and player phones only ever talk to BXQ's own server.

## Features

BXQ runs its own brackets since RFC-002; before that it ran on top of Challonge (RFC-001). Tournaments imported from Challonge were deleted in that change.

### Tournaments and brackets

| Feature | Notes |
|---|---|
| New tournament | `/tournaments/new`: a name, a format and its options, an optional group stage, and the players in seed order. Type one name at a time, or paste many separated by commas or new lines. |
| Formats | Single elimination (optional third-place match), double elimination (grand final with a reset, or single), round robin (each pair once or twice) and Swiss (the suggested number of rounds, or yours). Built by BXQ's own engine in `lib/bracket/`. |
| Two-stage tournaments | A group stage, then a final stage, each in any of the four formats. You set how many groups and how many of each go through; players are spread over the groups by snake seeding. Group matches read "Group A · Round 2" on every screen, and the queue takes the groups in turn. |
| Players and seeds | Before the start, the Desk's "Players and seeds" panel adds one or many players, renames them, moves them up or down, removes them, or shuffles the seeds. They are fixed once you press Start tournament, which asks first. |
| Results | When the judge confirms a result, the winner moves on (and in double elimination the loser drops to the losers bracket), the stadium frees up and the next match is called. A Swiss pairs its next round as soon as a round is played, avoiding rematches. |
| Corrections | A corrected winner that would erase later results lists them and asks first. Erased battles are voided, not deleted. In a round robin or Swiss a correction changes that match only. |
| Standings | A round robin, Swiss, every group, and a round robin or Swiss final stage get standings: wins, then Buchholz, head-to-head, Beyblade X points difference and seed. On the Desk under the Queue, and on the board taking turns with "In the hole", 15 seconds each, the best 10 of each table. Never on a Pass. |
| End group stage, Start final stage | Two steps on the Desk, so you see who goes through in between. Group winners are seeded first, then runners-up, and players from the same group are kept apart in the first round where possible. Group results can't be corrected after the first step. |
| Drop a player | In **Players and passcodes**. Their open matches, and any they would have reached, go to their opponents as forfeits ("won by forfeit"). Their results stand and they keep their Pass. |
| Late players | In a running Swiss, a late player can be added there; they are paired from the next round. |
| Finish tournament | Once the final stage is played out. Every player gets their place; the board shows the final standings and each Pass the player's place. No result can change after it. |
| Bracket page | `/tournaments/<id>/bracket`, linked from the Desk once started: every round of every group and stage as columns, the winners and losers brackets and the finals of double elimination, byes as gaps, the winner of each match marked. A match with both players opens its pad. For the organizer only. |
| Delete tournament | At the bottom of the Desk, after typing the tournament's name. |

### Rules and scoring

| Feature | Notes |
|---|---|
| Rule profiles | 4 presets plus your own: points per finish, target, best-of sets, finals override, launch-error penalty, own finish, and capped scores |
| BXQ Pad | Tablet-first, forced dark. Taps are saved per battle, idempotent, and retried. Undo and draw. Keeps the screen awake. A called match is started on the pad. |
| Battle scores | Each finished match opens a dialog on the Desk with every battle: who scored, the finish, the points and the running score. A player sees their own finished matches battle by battle on their Pass. |

### The floor

| Feature | Notes |
|---|---|
| Stadium lanes on the Desk | Now and On deck for each stadium, in the bracket's play order. Auto-call when a stadium frees up. Call / Start / No-show hold. Add, rename and remove stadiums. |
| Manual or automatic on deck | A "Fill on deck automatically" switch, separate from "Call automatically". With it off, you place matches from the queue. Back to queue, and Move to another stadium's empty on-deck slot. |
| Hold / Cancel a match in progress | Hold keeps the recorded battles. Cancel voids them and restarts the match at 0–0. Both leave the match HELD until you release it. |
| Recall players | "Second call", "Third call" and so on: chime and voice on the board, plus another push. 15-second cooldown. |
| BXQ Board | For a TV, after you approve the screen. "Now calling", live scores, "In the hole", standings and a QR code. Calls are announced with a chime and spoken aloud. |
| BXQ Pass | Players sign in and see whether they're called, on deck, queued or waiting. It updates live. |
| Web push for players | "On deck at Stadium 2", then "You're up at Stadium 2", even when the page is closed. Players opt in on their Pass. Each tournament has its own manifest, so "Add to Home Screen" opens that tournament's Pass; on iPhone, notifications only work after this step. |
| Short links | Each tournament has a 6-character code: `/b/<code>` opens BXQ Board and `/j/<code>` the BXQ Pad sign-up. The Desk shows both; clicking one copies it. |
| Judge tablets | A judge opens the judge link, picks a stadium, and you approve the tablet on the Desk. It can only score the match at its stadium, and follows that stadium from match to match. One judge per stadium. "Judge here myself" makes you its judge. A judge can leave, and rename themselves. |
| No judge, no start | A called match can't start until its stadium has a judge. Calls still go out. |

**Live updates:** the board, the Pass and the Desk poll our own server, using a version ETag. The board and the Desk also listen on Supabase Realtime: a database trigger announces each change, they fetch at once, and their polling drops to a check every 60 seconds while that connection is up. Player phones poll every 10 seconds and rely on push notifications for the call itself. When testing with phones on the venue Wi-Fi, set `APP_URL` to your laptop's LAN address (e.g. `http://192.168.1.10:3000`) so the QR code works.

**Testing push locally:**

1. Open BXQ Pass (`/t/<slug>`) in Chrome or Edge on `http://localhost:3000`.
2. Pick a player, enter their passcode (listed under **Players and passcodes** on the Desk) and click **Enable notifications**.
3. Call that player's match from the Desk.

Phones need HTTPS (for example a tunnel or a deployed URL).

### Offline

| Feature | Notes |
|---|---|
| Offline BXQ Pad | Taps are stored on the device (IndexedDB) and sync in the background. A lost connection, a reload or a crashed tab loses nothing. |
| Offline results | A match finished offline is saved automatically when the connection returns. |
| Pads that open offline | Pads are cached by a service worker, and the Desk pre-loads the pads of matches at stadiums. |
| Device banner | The Desk lists anything still only on this device, and why. |

### Access

| Feature | Notes |
|---|---|
| Magic-link sign-in for organizers | Supabase Auth, invite-only: sign-ups are off (`enable_signup = false` in `supabase/config.toml`; "Allow new users to sign up" in a hosted project). `npm run invite -- <email>` sends the invite. Anyone else is told "This email doesn't have access yet", with Request Early Access when it is set. |
| Boards need approval | A screen opening `/t/<slug>/board` shows a pairing code until you approve it on the Desk. A limit per tournament (default 1, in Venue settings), a live count of open boards, and Disconnect. |
| Player passcodes | Each player signs in with a 4-digit passcode, or by scanning the personal QR code on their slip, on one device at a time. The Desk lists passcodes, issues new ones and prints the slips. 10 wrong tries in 10 minutes lock the device that made them out of that player; 60 in an hour lock the player everywhere; the QR code works all along. |
| Players see only their own matches | The server sends each phone just that player's data. |
| A screen that closes | A board, a judge tablet or a Pass says so as its tab closes, and the Desk shows it closed within seconds. |

### The public site

| Feature | Notes |
|---|---|
| Landing page at `/` | For organizers who aren't signed in: a megaphone-and-paper tournament day next to one run with BXQ, the flow from a tap on the pad to the call on the board, the four screens and an FAQ. Signed-in organizers see "Go to Dashboard". |
| Animated preview | An 8-second loop of one match: the judge taps Burst on the pad, the winner moves on in the bracket, the next player gets "You're up", and the board calls the match. A [Remotion](https://www.remotion.dev) composition drawn in code with made-up names, rendered by `@remotion/player`. A still is shown until it loads, and to people who ask for reduced motion. |
| Request Early Access | Opens `EARLY_ACCESS_URL` in a new tab. Without that variable the button is disabled. |
| Terms of Service and Privacy Policy | `/terms` and `/privacy`, open without signing in. They name the operator from `OPERATOR_NAME` and give `CONTACT_EMAIL`. The policy lists what the app really stores (keep it in step with `lib/db/schema.ts`). Both are drafts, not legal advice: have them reviewed before relying on them. |
| Share preview | `/opengraph-image` is drawn in code and served without signing in. |

## Stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript
- **UI:** Tailwind CSS with shadcn/ui. The landing page's animation uses Remotion, which is free for individuals and for companies of up to three people; larger companies need a [company licence](https://www.remotion.dev/docs/license).
- **Auth and database:** Supabase for auth and Postgres, with Drizzle ORM. App tables live in a private `app` schema that the Supabase Data API does not expose.
- **Tests:** Vitest, with unit tests plus database integration tests against local Supabase; Playwright for the end-to-end suites

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
3. **Create `.env.local`** from `.env.example`. `npx supabase status` prints the URL and the publishable key.
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
6. **Create a tournament** with **New tournament** on the Tournaments page.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Unit tests. Also runs the integration tests when `.env.local` points at a database. |
| `npm run test:e2e` | Offline BXQ Pad, setting a tournament up and its bracket page, the Desk, a two-stage tournament and its standings on the Desk, the board and the Pass, navigation, board and Pass access, battle scores, judge tablets, light and dark mode, the landing page, and invite-only sign-in in a real browser (installed Edge; set `E2E_BROWSER=chrome` for Chrome, or `E2E_EXECUTABLE` to the path of a Chromium build). Needs local Supabase and `npm run build && npx next start -p 3100`. |
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
    tournaments/             list; new/ creates a tournament
    rules/                   rule profiles
  (control)/tournaments/[id]/  BXQ Desk (own header, no app navigation); bracket/ is the bracket page
  (judge)/tournaments/[id]/matches/[matchId]/  the organizer's own BXQ Pad
  t/[slug]/                  BXQ Pass; board/ is BXQ Board, judge/ a judge tablet's BXQ Pad
  b/[code]/ · j/[code]/      short links to BXQ Board and the BXQ Pad sign-up
lib/
  bracket/                   the bracket engine: every format, standings, placements, two-stage seeding (pure)
  tournament/                creating, starting and running tournaments on the engine
  scoring/                   rule profiles + presets, pure scoring engine
  battles.ts · rules.ts      BXQ Pad ops (idempotent) and rules resolution
  db/                        Drizzle schema + client
  control-room.ts            pure queue builder (unit-tested on real bracket data)
  standings.ts               pure running standings, for the Desk and the board
drizzle/                     SQL migrations
tests/                       unit, integration and end-to-end tests
docs/                        PRD, architecture, design system, brand guide, RFCs
```

## Deploying

You need a hosted Supabase project and a Node host such as Vercel. Set the same variables as in `.env.example`. Use the project's transaction-pooler URL (port 6543) as `DATABASE_URL`: every server instance keeps its own connections, and the session pooler runs out of them ("max clients reached") once a few instances are warm. Migrations use the same variable.

On Vercel, only a push to `main` deploys: `git.deploymentEnabled` in `vercel.json` turns automatic deployments off for every other branch, so a working branch gets no preview deployment. Migrations run by themselves: `vercel.json` runs `scripts/migrate-on-deploy.mjs` before each build, which applies pending migrations for production deploys only and fails the deploy if one fails. On another host, run `npm run db:migrate` against the database before deploying.

The rest of `vercel.json`:

| Setting | Value | Why |
|---|---|---|
| `framework`, `installCommand` | `nextjs`, `npm ci` | Installs exactly what `package-lock.json` says |
| `regions` | `icn1` (Seoul) | Server functions run next to the Supabase database (`ap-northeast-2`), so each query stays in the region. Change it if your database is elsewhere. |
| `functions` | `maxDuration` 30 s for `app/api/**` | A stuck request from a pad or a screen stops after 30 seconds |
| `github` | `autoJobCancelation`, `silent` | A newer push to `main` cancels the older build; Vercel doesn't comment on commits |
| `headers` | HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` | No page can be framed. Camera, microphone, location and the like are off; fullscreen (board), screen wake lock (pad) and clipboard (Desk) stay on for BXQ itself. |
| `headers` on `/sw.js` | `Cache-Control: no-cache` | A new service worker reaches pads on the next visit |

Live updates use Supabase Realtime on public channels, which is on by default for a new project. If Realtime is unavailable, screens fall back to polling by themselves.

In the Supabase dashboard, add `https://<your-domain>/**` to **Auth → URL Configuration → Redirect URLs**. To keep sign-in invite-only, turn off **Allow new users to sign up** under Authentication, and paste `supabase/templates/invite.html` into the **Invite user** email template, so the invite link goes through the app's own `/auth/confirm`. Invite organizers from **Authentication → Users**, or with `npm run invite`.
