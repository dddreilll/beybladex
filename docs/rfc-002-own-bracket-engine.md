# RFC-002: BXQ's own bracket engine

| | |
|---|---|
| **Status** | Done (2026-10-17). Supersedes [RFC-001](rfc-001-architecture.md). |
| **Date** | 2026-10-17 |
| **Scope** | Replace Challonge as BXQ's bracket engine with BXQ's own, built for Beyblade X |

## Why

Under RFC-001, Challonge held the bracket and BXQ ran the floor around it. That worked, but it shaped everything:

- **The request budget.** Challonge's free tier allows 500 requests per 30 days, per app. Every import, resync, result, round and finalize had to be counted, and a large event used a third of a month.
- **Bring-your-own OAuth.** Each organizer had to create a Challonge developer app and paste its credentials into BXQ before they could run anything. BXQ stored encrypted secrets and refreshed rotating tokens.
- **Two copies of the bracket.** BXQ kept its own copy of the matches and had to learn what Challonge didn't expose: which match a winner moves on to, which group a match is in, when the next Swiss round appears (35 to 300 ms after the result that ends a round). A 200 from Challonge didn't always mean a change was applied.
- **Rules BXQ couldn't change.** Tie-breaks, pairing and placements were Challonge's, so BXQ's standings were labelled "not official".

Beyblade X needs only one-against-one matches in four formats and two-stage tournaments. That is small enough to build, test and own.

## Decisions

Agreed with the project owner before any code was written.

| Question | Decision |
|---|---|
| Replace Challonge, or run both? | Replace it fully. BXQ writes its own engine; Challonge code, tables and settings are removed. |
| Tournaments already imported from Challonge | Dropped. Migration 0016 deletes them. |
| Rollout | Cut over directly, with no period where both run. |
| Standings tie-breaks | Wins, then Buchholz, then head-to-head, then Beyblade X points difference, then seed. |
| How players are entered | Typed by the organizer, one at a time or many separated by commas (or new lines). |
| Public export of brackets | None. |
| Bracket view | A bracket page for the organizer at `/tournaments/<id>/bracket`, linked from the Desk (since M7, a tab on the Desk). Not on the TV board; the Pass shows the player's own matches only. |
| Match names (M7) | Numbers only, no letters: one run per tournament, in the order the queue plays them. "M12" on the Desk and the bracket, "Match 12" on the board, the pad, notifications and the Pass. |
| Desk layout (M7) | Stadium cards stay on top; Queue, Standings, Players, Completed and Bracket are tabs under them. The bracket page becomes the Bracket tab. |
| RFC-001 and the spikes | RFC-001 stays as history, marked superseded. `spikes/` is deleted. |

## Design

### A pure engine

`lib/bracket/` is pure TypeScript: players in seed order go in, matches come out. It never reads or writes the database, so every format is unit-tested in isolation (`tests/bracket/`), including every size from 2 to 33 players for the brackets.

A match carries a stable `key` ("R2-1", "L3-2", "GF1", "3P"), a round, a play order, and the slots its winner and loser go to (`winnerTo`, `loserTo`). Progress is two functions: `recordWinner` moves the players on, and `correctWinner` changes a winner and returns the later matches whose results it erases. Until M7 the engine also lettered matches (A, B, … Z, AA); since then `lib/tournament/` numbers them across the whole tournament as it stores them.

| Format | How |
|---|---|
| Single elimination | The bracket for the next power of 2, seeded 1, 8, 4, 5, 2, 7, 3, 6 for 8, so seeds 1 and 2 meet only in the final. A bye is not a match: the player facing it starts in round 2. Optional third-place match. |
| Double elimination | The full bracket for the next power of 2, then the byes taken out on both sides, so n players play 2n − 2 matches plus the reset. Losers drop crossed over to put off rematches. A grand final that resets, or a single one. |
| Round robin | The circle method, one or two legs. |
| Swiss | Round 1 top half against bottom half. Later rounds pair players on the same wins top half against bottom half, with a bounded search that avoids rematches and allows them only if nothing else works. With an odd count, the lowest-ranked player without a bye has one, counted as a win. Suggested rounds: enough to leave one player unbeaten. |
| Two-stage | Groups by snake seeding. A group's ranking once it is played out; a group that is a bracket is played to the end, so everyone has a place. The final stage seeds every group winner, then every runner-up, then swaps within a tier so nobody meets their own group in the first round where it can be avoided. |

Standings rank by wins, then Buchholz, head-to-head, points difference and seed, so every tie is broken and the standings are the places once a stage is over. In a bracket, players knocked out in the same round share a place unless a third-place match separates them.

### The server records every change

`lib/tournament/` connects the engine to the database. A result is one transaction under a row lock on the tournament: score the match from its battles, let the engine record the winner, write what changed, settle the stage (forfeits for dropped players, the next Swiss round), and plan the queue again. A correction that would erase later results returns the list first and needs confirmation, as under RFC-001; the battles of wiped matches are voided, never deleted.

The pad, its offline outbox, the queue, push, the board and the Pass were kept as they were. Their endpoints didn't change, so a pad cached before the change still syncs.

### Data model

- **Removed:** `challonge_connections`, `api_usage`, `sync_outbox`, every Challonge ID, ETag and URL column, the learned next-match links, and `APP_ENCRYPTION_KEYS` with `lib/crypto/secrets.ts` (migration 0017).
- **Added to `tournaments`:** `group_count`, `advance_per_group`, `grand_final`, `third_place`, `round_robin_legs` (0018). `state` now holds BXQ's own values: `pending`, `group_stage`, `between_stages`, `underway`, `complete`.
- **Added to `participants`:** `group_number`, and `final_seed`, the seed in the final stage of a two-stage tournament (0018). Player sessions and push subscriptions now point at the participant's own ID.
- **Added to `matches`:** `key`, `play_order`, the players and the winner as participant IDs, `section`, `third_place`, `if_needed`, `bye`, `winner_to`, `loser_to`, `reported_by` and `reported_at` (0018), and `forfeit` (0019).

Participant IDs are the player IDs the engine works with. A group's match keys carry a prefix (`G1:R2-1`), so every key is unique in a tournament.

### What it costs

Nothing outside BXQ. No request budget, no OAuth app, no stored secrets. Every request cost table in the documents was removed.

### What changes for organizers

- A tournament is created in BXQ: name, format, options, players. Players and seeds can be changed on the Desk until the start.
- "Finalize" is now "Finish tournament", and needs no outside confirmation.
- A player is dropped on the Desk, not on challonge.com; their matches go to their opponents as forfeits. A late player can join a running Swiss.
- Standings use real tie-breaks and are the places.
- The whole bracket is on its own page.

## Risks

| Risk | How it is handled |
|---|---|
| A pairing or progression bug in the engine | The engine is pure and covered by unit tests for every format and size, plus database integration tests that play whole tournaments out, and end-to-end tests in a browser. |
| Losing the tournaments imported from Challonge | Accepted: the project owner chose to drop them. |
| Two results for one bracket at once | Every change to a bracket runs under a row lock on the tournament. |
| A pad cached before the change | The pad's endpoints and operations didn't change. |

## Milestones

All seven were built and pushed to the `claude/clever-babbage-c07iq6` branch, each after typecheck, lint and the tests passed.

### M1: the engine core (done 2026-10-17)

Single elimination with byes and an optional third-place match; round robin with one or two legs; match letters; the checks on a list of players. Unit tests only; nothing in the app used it yet.

### M2: double elimination and corrections (done 2026-10-17)

Double elimination with byes pruned on both sides, crossed-over drops, and a grand final that resets or not. `recordWinner` and `correctWinner`, the second returning the matches it erases.

### M3: Swiss, standings and two-stage (done 2026-10-17)

Swiss pairing with byes and a rematch fallback; standings with Buchholz, head-to-head and points difference; placements for every format; snake groups, group ranking and the seeding of the final stage.

### M4: the app runs on the engine (done 2026-10-17)

The cut-over. Migrations 0016 to 0018 drop the imported tournaments, remove the Challonge tables and columns, and add the bracket columns. `lib/tournament/` records results, corrections, forfeits and Swiss rounds, ends the group stage, starts the final stage and finishes the tournament. `lib/challonge/`, the settings page, the import dialog and the budget meter are gone. Integration and end-to-end tests were ported off the fake Challonge.

### M5: creating and setting up tournaments (done 2026-10-17)

The New tournament page; the Desk's "Players and seeds" panel (add one or many, rename, move, remove, shuffle) and Start tournament; dropping a player, with forfeits (migration 0019); late players in a Swiss; deleting a tournament. A new end-to-end suite, `setup.e2e.mjs`.

### M6: the bracket page and the documents (done 2026-10-17)

`/tournaments/<id>/bracket` with its pure layout (`lib/tournament/bracket-layout.ts`); a forfeit shown on the Pass; the landing page, Terms of Service, Privacy Policy and metadata without Challonge; `spikes/` deleted; RFC-001 marked superseded; the README, PRD, architecture, design system, brand guide and AGENTS.md rewritten for the engine.

### M7: match numbers and Desk tabs (done 2026-10-17)

- **Match numbers.** The letters are gone. `matches.number` numbers every match once per tournament (migration 0020, which numbered existing matches; 0021 drops `identifier`). `numberMatches` gives them in the order the queue plays them, so the matches of the groups take turns; the groups are stored together at the start for that reason, and later Swiss rounds and the final stage carry on from the last number. A Swiss bye has no number. The Desk and the bracket say "M12"; the board, the pad, notifications and the Pass say "Match 12".
- **Desk tabs.** Under the stadium cards, `lib/desk-tabs.ts` decides the tabs (Queue, Standings when the format has them, Players, Completed, Bracket; only Players before the start) and the open one, kept in the address as `?tab=`. Players and passcodes is a plain section now, with Delete tournament under it. The bracket page became the Bracket tab, and its old address redirects there.

## Not done

- Importing from or exporting to Challonge or another bracket site.
- A public bracket page, and a bracket on the TV board.
- Places 5th and below separated by consolation matches in single elimination.
- Editing a bracket or overriding a Swiss pairing by hand after the start.
