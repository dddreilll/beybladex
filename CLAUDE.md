# BXQ

A web app for running Beyblade X tournaments on top of Challonge. Setup, scripts and the folder layout are in [README.md](README.md); the design is in [docs/rfc-001-architecture.md](docs/rfc-001-architecture.md).

## Naming

Follow [docs/brand.md](docs/brand.md) in all UI copy, documentation and metadata.

- The app is **BXQ**; the tagline is "Your stadium is ready." Read both from `lib/config.ts` (`APP_NAME`, `APP_TAGLINE`).
- The four screens are **BXQ Desk** (organizer control room), **BXQ Board** (TV display), **BXQ Pad** (judge tablet) and **BXQ Pass** (player page).
- Full name in titles, headings and first mentions; short form ("the Desk", "the board", "the pad", "their Pass") after that.
- If "Stadium Control", "control room", "call board", "judge pad" or "player page" turns up in user-facing text or docs, point it out and suggest the new name. Comments, identifiers and file names keep their existing names.

## Constraints

- Stay within Challonge's free 500 requests a month. Boards and player phones never call Challonge.
- The technical pillars at the end of docs/brand.md must stay true.
