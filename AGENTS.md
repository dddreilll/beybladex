# BXQ

A web app for running Beyblade X tournaments on top of Challonge. These are the rules for AI coding agents working in this repository.

| Read | For |
|---|---|
| [README.md](README.md) | Setup, scripts, the folder layout, deployment |
| [docs/PRD.md](docs/PRD.md) | What the product is for, and what each milestone delivered |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it is built today |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Colours, type, components, and the patterns of each screen |
| [docs/brand.md](docs/brand.md) | The name, the tone, the screen names |
| [docs/rfc-001-architecture.md](docs/rfc-001-architecture.md) | Why it is built this way: decisions, Challonge API findings, the record of each milestone |

## Naming

Follow [docs/brand.md](docs/brand.md) in all UI copy, documentation and metadata.

- The app is **BXQ**; the tagline is "Your stadium is ready." Read both from `lib/config.ts` (`APP_NAME`, `APP_TAGLINE`).
- The four screens are **BXQ Desk** (organizer control room), **BXQ Board** (TV display), **BXQ Pad** (judge tablet) and **BXQ Pass** (player page).
- Full name in titles, headings and first mentions; short form ("the Desk", "the board", "the pad", "their Pass") after that.
- If "Stadium Control", "control room", "call board", "judge pad" or "player page" turns up in user-facing text or docs, point it out and suggest the new name. Comments, identifiers and file names keep their existing names.

## Constraints

The technical pillars at the end of docs/brand.md must stay true. Three of them need care in almost every change.

### Challonge requests

Stay within Challonge's free 500 requests a month.

- **Only server code calls Challonge.** Never call it from a client component, and never from anything a board, a pad or a player's phone loads or polls.
- **Use the metered client** (`challongeClientFor` in `lib/challonge/connection.ts`), so every request is counted. Don't call `fetch` on `api.challonge.com` outside `lib/challonge/`.
- **Send the stored ETag** when re-reading something that may not have changed, as `resyncTournament` does.
- **No Challonge request on a timer, on page load or on a poll.** A request follows something the organizer or a judge did: import, Resync, a result, a correction, finalize.
- **A control that costs requests the organizer didn't expect says so,** like "Show my Challonge tournaments (1 request)".
- **A change that adds requests says how many,** and updates the cost tables in docs/PRD.md and docs/ARCHITECTURE.md.
- **A 200 from Challonge doesn't mean the change was applied.** Check the returned state, as `lib/challonge/report.ts` does.
- **Tests never call the real API.** Use the fake in `tests/integration/fake-challonge.ts` and the recorded fixtures.

Screens stay live by polling BXQ's own endpoints with a version ETag, with Supabase Realtime as a hint. Build on `components/board/use-board.ts` and `startChecks` in `board-signal.ts`; don't write a new polling loop.

### Offline on the pad

Anything a judge does on the pad has to work with no connection and lose nothing.

- **A pad action is an operation in the outbox** (`lib/offline/outbox.ts`), with a client-made `op_id`. It applies on the device at once and syncs later.
- **The server accepts the same operation twice** without doing it twice.
- **Pad endpoints are plain route handlers** under `app/api/matches/`, not server actions. A server action's ID changes on every build, so a pad restored from the offline cache after a deploy could not sync.
- **A new pad route has to be cached.** Add its path to `PAD_PATH` in `public/sw.js`.
- **Cover it in `tests/offline/` and in `tests/e2e/offline-pad.e2e.mjs`.**

### Access

- **A player's phone is sent that player's data only.** Nothing about other players goes to `/api/public/<slug>/me`.
- **A board or a judge tablet gets nothing until the organizer approves it.**
- **Secrets never reach the browser.** Challonge client secrets and tokens are encrypted with `lib/crypto/secrets.ts` before they are stored.
- **A change to what is stored is reflected in the Privacy Policy** (`app/privacy/page.tsx`), which lists what the app keeps.

## Code

- **TypeScript, Next.js 16 App Router.** Server components by default; `"use client"` only where a component needs state, effects or browser APIs. Server-only modules import `server-only`.
- **Next.js 16 uses `proxy.ts`,** not `middleware.ts`.
- **Logic goes in `lib/` as small, pure modules** with unit tests, like `lib/queue.ts` and `lib/scoring/engine.ts`. Components and route handlers stay thin.
- **Validate input at the boundary** with Zod.
- **Database changes** start in `lib/db/schema.ts`. Run `npm run db:generate` and commit the migration it writes to `drizzle/`. Tables belong to the `app` schema.
- **UI** follows docs/DESIGN_SYSTEM.md: theme tokens, not hex values; `components/ui/` before a new component; the venue screens stay dark.
- **Match the code around you:** its naming, its comment density, its idiom.

## Before you finish

1. `npm run typecheck` and `npm run lint`.
2. `npm test`. The integration tests also run when `.env.local` points at a database.
3. For a change to a screen, `npm run test:e2e`. It needs local Supabase and a built app; the README has the steps.
4. Update the documents the change touches: the README's feature tables, and the PRD, architecture or design system where they describe what changed.

Report what you ran and what it showed. If a step was skipped, say so.
