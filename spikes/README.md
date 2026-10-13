# Spikes for RFC-001

These are throwaway proof-of-concept scripts for spikes S1–S4 in [../docs/rfc-001-architecture.md](../docs/rfc-001-architecture.md). They are not app code: they have no dependencies and only minimal error handling, and they are deleted once the answers are recorded in the RFC.

They need Node 20.6 or later, because they use `--env-file` and the built-in `fetch`.

## What gets created

| Path | Contents |
|---|---|
| `spikes/out/requests.jsonl` | One line per request to Challonge: method, URL (secrets redacted), status, timing, and any caching or rate-limit headers |
| `spikes/out/fixtures/*.json` | Raw API responses (tokens redacted). These become the app's contract-test fixtures later |
| `spikes/out/summary-*.json` | The answers each spike was looking for |
| `spikes/out/tokens.json` | Your OAuth tokens, **in plain text**. Fine for a local spike, but never commit it |

`out/` and `.env` are gitignored.

## Setup (done on Challonge, once)

1. **Create an app** at https://connect.challonge.com and add this redirect URI exactly:
   `http://localhost:3000/api/challonge/oauth/callback`
2. **Create a test tournament** on challonge.com. Its name **must start with `[SPIKE]`**, because S4 refuses to touch anything else. Make it double elimination with 16 placeholder participants, and don't start it.
3. **Write down the Developer Portal's request usage** before you run anything.
4. **Configure the scripts:** `cp spikes/.env.example spikes/.env`, then fill in the client ID, client secret and tournament ID.

## Run, in order

Run these from the `spikes/` folder:

| Command | Spike | Writes to Challonge? | Approx. requests |
|---|---|---|---|
| `npm run s1` | S1: authorization code exchange, `/me`, token refresh | No | 4–6 |
| `npm run s1:cc` | S1b: client-credentials flow (`application:manage`), with no browser step. Shows which tournaments an app token can see | No | 4–6 |
| `npm run s0` | Adds 16 placeholder participants (`--count=N`, up to 20) if the tournament has none | **Yes, only on a `[SPIKE]` tournament** | 2 |
| `npm run s4 -- --confirm` | S4 + S3: starts the tournament, reports scores, reopens a match | **Yes, only on a `[SPIKE]` tournament** | ~12 |
| `npm run s2` | S2 + S3: `per_page` cap, ETag/304 behaviour, match fields. Run it after S4, because matches only exist once the tournament has started | No | ~9 |
| `npm run s5 -- --confirm` | S4b: correcting a result. Flips the winner of the S4 match, plays the next match, then tries to flip and reopen again | **Yes, only on a `[SPIKE]` tournament** | 12–20 |
| `npm run s6 -- --confirm` | S6: formats. Creates two private `[SPIKE]` tournaments of 8 players (single elimination with a third-place match, double elimination without grand finals), starts and reads them, reads the tournament list, then resets and deletes them. `--keep` leaves them on your account. It doesn't use `SPIKE_TOURNAMENT_ID` | **Yes, only on the two tournaments it creates** | 13 (9 with `--keep`) |
| `npm run s7 -- --confirm` | S7: round robin and Swiss. Creates three private `[SPIKE]` tournaments: a 4-player round robin and a 5-player Swiss, each played to the end with a correction (and a tie in the round robin), and a 16-player round robin to see how many matches one list request returns. Then resets and deletes them; `--keep` leaves them. It doesn't use `SPIKE_TOURNAMENT_ID` | **Yes, only on the three tournaments it creates** | 38 (32 with `--keep`) |
| `npm run s8 -- --confirm` | S8: what S7 left out. A 6-player Swiss with a tie in round 1 and a player dropped before round 2, and a 3-player round robin with two iterations that is only read. Then resets and deletes them; `--keep` leaves them. It doesn't use `SPIKE_TOURNAMENT_ID` | **Yes, only on the two tournaments it creates** | 21 (17 with `--keep`) |
| `npm run s9 -- --confirm` | S9: Swiss rounds after a drop. A 6-player Swiss of 4 rounds: rounds 1 and 2 with nobody dropped, a player dropped during round 3, then round 4 read at once and again after 20 seconds. Then resets and deletes it; `--keep` leaves it. It doesn't use `SPIKE_TOURNAMENT_ID` | **Yes, only on the tournament it creates** | 20 (18 with `--keep`) |
| `npm run s10 -- --confirm` | S10: why a round was missing in S8. Replays S8's 6-player Swiss of 3 rounds with its tie and its drop (`--variant=replay`, the default), or without the tie (`--variant=no-tie`) or without the drop (`--variant=no-drop`). If round 3 is missing it reads again after 30 and 90 seconds. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 14 to 16 |
| `npm run s11 -- --confirm` | S11: reads the match list while and just after the last result of a Swiss round is sent (150, 250 and 350 ms after sending it, and when it returns), then 3 seconds later, for two rounds of a 4-player Swiss. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 20 (18 with `--keep`) |
| `npm run s12 -- --confirm` | S12: in a 4-player double elimination bracket, reports both first-round matches and compares how long the second result's request ran on the server with when the next winners and losers matches were updated. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 9 (7 with `--keep`) |
| `npm run s13 -- --confirm` | S13: four more measurements of the same. In an 8-player double elimination bracket, reports the four first-round matches one at a time and reads the bracket after each. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 14 (12 with `--keep`) |

For `npm run s1`, open the printed URL in your browser and approve access. The script listens on port 3000 for the redirect back.

After each run, compare the request count it printed with how much the Developer Portal usage went up. That comparison is the S2 answer to "what counts against the budget?"

To run S4 again, reset the tournament on challonge.com first.

## Results to bring back into the RFC

| Question | Where the answer is |
|---|---|
| Does the token exchange take a form body or query params? | `summary-s1.json` → `token_transport` |
| Which scopes were granted, and how long do tokens last? | `summary-s1.json` → `granted_scopes`, `expires_in` |
| Does refreshing rotate the refresh token? | `summary-s1.json` → `refresh_rotates_refresh_token` |
| Does the client-credentials flow work for our own app, and what does `/application/tournaments.json` return? | `summary-s1.json` → `client_credentials_status` and the related fields |
| Is `per_page` capped? | `summary-s2-s3.json` → `per_page` |
| Are ETags supported, and does a conditional request return 304? | `summary-s2-s3.json` → `etag_present`, `conditional_status` |
| Do 304 responses or token refreshes count against the budget? | The Developer Portal usage compared with `requests.jsonl` |
| Do matches link to their next or previous matches? | `summary-s2-s3.json` → `possible_progression_fields` |
| What changes in the bracket after one report, and after a reopen? | `summary-s4.json` → `progression_after_report`, `progression_after_reopen` |
| How are a score over the target and best-of-3 sets stored? | `summary-s4.json` → `steps[report-overshoot]`, `steps[report-multi-set]` |
| What do errors look like (for example, a tie in an elimination bracket)? | `out/fixtures/s4-report-tie.json` |
| Does the tournament list carry the group stage and the format options? | `summary-s6.json` → `list.attribute_keys`, `list.created_found` |
| How does a third-place match appear, and which round is it in? | `summary-s6.json` → `tournaments.single-third-place` |
| Which matches does a double elimination bracket without grand finals have? | `summary-s6.json` → `tournaments.double-no-grand-finals` |
| Do results sent the way BXQ sends them work in round robin and Swiss? | `summary-s7.json` → `round-robin.report`, `swiss.round_1_reports` (`accepted`) |
| What does a tie look like in round robin? | `summary-s7.json` → `round-robin.tie` |
| What else changes when a result is corrected? | `summary-s7.json` → `round-robin.changes_since_start`, `swiss.after_correction` |
| Does Swiss pair the next round by itself, and what does a bye look like? | `summary-s7.json` → `swiss.round_1`, `swiss.after_round_1` |
| How many matches does one list request return? | `summary-s7.json` → `big-round-robin.list` |
| Is a tie accepted in Swiss? | `summary-s8.json` → `swiss.tie` |
| What happens to a player who drops out, to their open match and to the next round? | `summary-s8.json` → `swiss.drop`, `swiss.after_drop`, `swiss.after_round_2` |
| How is a round robin with an odd number of players and two iterations laid out? | `summary-s8.json` → `round-robin-twice` |
| Is the next Swiss round still paired after a player drops out? | `summary-s9.json` → `round_3_paired_without_a_drop`, `round_4_paired_at_once`, `round_4_paired_after_waiting` |
| Does the tie or the drop of S8 make round 3 go missing? | `summary-s10-replay.json` → `round_3_at_once` |
| Is the next round created inside the result request or after it? | `requests.jsonl` → `x-runtime` of the round's last result, against the `created_at` of the next round's matches in `fixtures/s*-matches-after-round-*.json` |
| Can a read sent beside the last result of a round miss the next round? | `summary-s11.json` → `transitions[].reads` |
| In an elimination bracket, do the next matches open inside the result request? | `summary-s12.json` → `second_result.ran_ms`, `moved_on`, `verdict`; `summary-s13.json` → `samples[]` |
