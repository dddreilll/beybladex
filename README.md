# BXQ

**Your stadium is ready.**

BXQ is an open-source web app for running Beyblade X tournaments on top of [Challonge](https://challonge.com). The organizer calls players to stadiums, judges score battles finish by finish, and the Challonge bracket stays in sync.

The name joins "BX", Takara Tomy's product line code for Beyblade X, and "Q" for queue. The design, decisions and API findings are in [docs/rfc-001-architecture.md](docs/rfc-001-architecture.md); the name, tone and screen names are in [docs/brand.md](docs/brand.md).

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
| Tournament import | 3 Challonge requests |
| Resync | 2 requests when nothing changed, using an ETag/304 check |
| Read-only BXQ Desk | Ready-to-call matches in Challonge's suggested play order, matches waiting for an opponent, and completed results |
| Per-organizer request budget meter | The app counts every request itself, including 304s and token calls |

**M2 adds:**

| Feature | Notes |
|---|---|
| Rule profiles | 4 presets plus your own: points per finish, target, best-of sets, finals override, launch-error penalty, own finish, and capped scores |
| BXQ Pad | Tablet-first, forced dark. Taps are saved per battle, idempotent, and retried. Undo and draw. Keeps the screen awake. Since the judge tablets change, a called match has to be started on the pad first. |
| Sending results to Challonge | 2 requests per result. It checks that Challonge really applied the result, then refreshes the bracket. |
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
| `npm run test:e2e` | Offline BXQ Pad, the Desk, navigation, board and Pass access, battle scores, judge tablets, light and dark mode, the landing page, and invite-only sign-in in a real browser (installed Edge; set `E2E_BROWSER=chrome` for Chrome). Needs local Supabase and `npm run build && npx next start -p 3100`. |
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
drizzle/                     SQL migrations
tests/                       unit + integration tests, recorded Challonge fixtures
spikes/                      throwaway API spike scripts (see spikes/README.md)
docs/                        RFC
```

## Deploying

You need a hosted Supabase project and a Node host such as Vercel. Set the same variables as in `.env.example`. Use the project's transaction-pooler URL (port 6543) as `DATABASE_URL`: every server instance keeps its own connections, and the session pooler runs out of them ("max clients reached") once a few instances are warm. Migrations use the same variable.

On Vercel, migrations run by themselves: `vercel.json` runs `scripts/migrate-on-deploy.mjs` before each build, which applies pending migrations for production deploys only and fails the deploy if one fails. On another host, run `npm run db:migrate` against the database before deploying.

Live updates use Supabase Realtime on public channels, which is on by default for a new project. If Realtime is unavailable, screens fall back to polling by themselves.

In the Supabase dashboard, add `https://<your-domain>/**` to **Auth → URL Configuration → Redirect URLs**. To keep sign-in invite-only, turn off **Allow new users to sign up** under Authentication, and paste `supabase/templates/invite.html` into the **Invite user** email template, so the invite link goes through the app's own `/auth/confirm`. Invite organizers from **Authentication → Users**, or with `npm run invite`. Each organizer registers `https://<your-domain>/api/challonge/oauth/callback` on their own Challonge app.
