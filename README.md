# Stadium Control

A web app for running Beyblade X tournaments on top of [Challonge](https://challonge.com). The organizer calls players to stadiums, scores battles finish by finish, and the Challonge bracket stays in sync.

**Stadium Control** is a placeholder name, set in `lib/config.ts`. The design, decisions and API findings are in [docs/rfc-001-architecture.md](docs/rfc-001-architecture.md).

## Status: milestone M1

| Feature | Notes |
|---|---|
| Magic-link sign-in for organizers | Supabase Auth |
| Bring-your-own Challonge OAuth app per organizer | Client secret and tokens are encrypted at rest with AES-256-GCM. Refresh is automatic and locked against concurrent use, because Challonge rotates refresh tokens. |
| Tournament import | 3 Challonge requests |
| Resync | 2 requests when nothing changed, using an ETag/304 check |
| Read-only control room | Ready-to-call matches in Challonge's suggested play order, matches waiting for an opponent, and completed results |
| Per-organizer request budget meter | The app counts every request itself, including 304s and token calls |

**M2 adds:**

| Feature | Notes |
|---|---|
| Rule profiles | 4 presets plus your own: points per finish, target, best-of sets, finals override, launch-error penalty, own finish, and capped scores |
| Judge pad | Tablet-first, forced dark. Taps are saved per battle, idempotent, and retried. Undo and draw. Keeps the screen awake. |
| Sending results to Challonge | 2 requests per result. It checks that Challonge really applied the result, then refreshes the bracket. |
| Corrections | Warns and asks for confirmation before erasing matches that were already played. Failed sends can be retried from the control room. |

**M3 adds:**

| Feature | Notes |
|---|---|
| Stadium lanes in the control room | Now and On deck for each stadium. Auto-call when a stadium frees up. Call / Start / No-show hold. Add, rename and remove stadiums. |
| Public call board at `/t/<slug>/board` | For a TV. Shows "Now calling", live scores, "In the hole" and a QR code. Calls are announced with a chime and spoken aloud. |
| Public player page at `/t/<slug>` | Players pick their name and see whether they're called, on deck, queued or waiting. It updates live. |

**Live updates:** the board, player page and control room poll our own server, using a version ETag. They never call Challonge. When testing with phones on the venue Wi-Fi, set `APP_URL` to your laptop's LAN address (e.g. `http://192.168.1.10:3000`) so the QR code works.

**M4 adds:**

| Feature | Notes |
|---|---|
| Web push for players | "On deck at Stadium 2", then "You're up at Stadium 2", even when the page is closed. Players opt in on the player page. |
| Installable player page | Each tournament has its own manifest, so "Add to Home Screen" opens that tournament's player page. On iPhone, notifications only work after this step. |

**Testing push locally:**

1. Open the player page in Chrome or Edge on `http://localhost:3000`.
2. Pick a player and click **Enable notifications**.
3. Call that player's match from the control room.

Phones need HTTPS (for example a tunnel or a deployed URL).

**M5 adds:**

| Feature | Notes |
|---|---|
| Offline judge pad | Taps are stored on the device (IndexedDB) and sync in the background. A lost connection, a reload or a crashed tab loses nothing. |
| Offline results | A match finished offline is sent to Challonge automatically when the connection returns. |
| Pads that open offline | Pads are cached by a service worker, and the control room pre-loads the pads of matches at stadiums. |
| Device banner | The control room lists anything still only on this device, and why. |

All five milestones in the RFC are now built.

**After M5: control room redesign and queue controls**

| Feature | Notes |
|---|---|
| Control room layout | Matches the mockup: header row, stadium cards with live scores, queue table, sidebar. No app navigation on this page. |
| Recall players | Re-announces a called match as "Second call", "Third call" and so on: chime and voice on the board, plus another push. 15-second cooldown. |
| Manual or automatic on deck | A "Fill on deck automatically" switch, separate from "Call automatically". With it off, you place matches from the queue. |
| Back to queue | Sends an on-deck match back; the next ready match takes its slot. |
| Hold / Cancel a match in progress | Hold keeps the recorded battles. Cancel voids them and restarts the match at 0–0. Both leave the match HELD until you release it. |

## Stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript
- **UI:** Tailwind CSS with shadcn/ui
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
   Open http://localhost:3000 and sign in. Magic-link emails arrive in Mailpit at http://127.0.0.1:44324.
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
| `npm run test:e2e` | Offline judge pad, control room and navigation in a real browser (installed Edge; set `E2E_BROWSER=chrome` for Chrome). Needs local Supabase and `npm run build && npx next start -p 3100`. |
| `npm run typecheck` / `lint` | `tsc` and ESLint |
| `npm run db:generate` | Generate a migration after changing `lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations in `drizzle/` |
| `npm run supabase:start` / `supabase:stop` | Local Supabase |

## Layout

```
app/
  auth/                      magic-link login, confirm route, error page
  (organizer)/               signed-in pages; each uses the shared header + side navigation
    settings/challonge/      bring-your-own OAuth app: credentials, connect, remove
    tournaments/             list + import
  (control)/tournaments/[id]/  control room (own header, no app navigation)
  api/challonge/oauth/callback/
lib/
  challonge/                 API client, OAuth, connection + token refresh, sync, report, progression, budget
  scoring/                   rule profiles + presets, pure scoring engine
  battles.ts · rules.ts      judge-pad ops (idempotent) and rules resolution
  crypto/secrets.ts          AES-256-GCM envelopes + signed OAuth state
  db/                        Drizzle schema + client
  control-room.ts            pure queue builder (unit-tested on real bracket data)
drizzle/                     SQL migrations
tests/                       unit + integration tests, recorded Challonge fixtures
spikes/                      throwaway API spike scripts (see spikes/README.md)
docs/                        RFC
```

## Deploying

You need a hosted Supabase project and a Node host such as Vercel. Set the same variables as in `.env.example`, using the project's direct or session-pooler `DATABASE_URL`, and run `npm run db:migrate` against it.

In the Supabase dashboard, add `https://<your-domain>/**` to **Auth → URL Configuration → Redirect URLs**. Each organizer registers `https://<your-domain>/api/challonge/oauth/callback` on their own Challonge app.
