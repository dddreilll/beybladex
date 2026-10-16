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
| `npm run s14 -- --confirm` | S14: grand finals set to None. Plays a 4-player double elimination bracket up to its last round, reads that round, and asks Challonge to finalize. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 14 (12 with `--keep`) |
| `npm run s15 -- --confirm` | S15: consolation matches beyond third place. Creates an 8-player single elimination bracket with matches down to 7th place and reads its structure; nothing is played. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 6 (4 with `--keep`) |
| `npm run s16 -- --confirm` | S16: a whole event through BXQ itself. Creates a 4-player double elimination tournament (or a round robin with `--format=round-robin`, which costs 19: 13 by BXQ, 6 directly; or a 5-player Swiss of 3 rounds with `--format=swiss`, in which a player is also dropped on Challonge and BXQ resynced, which costs 25: 18 by BXQ, 7 directly), then drives the app in a browser as an organizer: import through the review dialog, a stadium, every match scored on the pad and sent, Finalize, and a comparison with what Challonge holds. **Needs local Supabase and the built app running** (`npx next start -p 3101`, or set `BXQ_BASE_URL`), and it puts a throwaway organizer with the spike's Challonge credentials, encrypted, in the local database; that organizer is deleted at the end. Screenshots go to `out/s16-shots-<format>/` and the summary to `out/summary-s16-<format>.json` | **Yes: the tournament it creates, and the local database** | 25 (19 by BXQ, 6 directly) |
| `npm run s17 -- --confirm` | S17: two-stage tournaments. One run creates one tournament with 2 groups, 2 players advancing from each and a single elimination final stage. `--variant=round-robin` (the default) plays it to the end, with a group result corrected after the final stage has begun; `--variant=swiss` plays the group stage with two corrections and ends it; `--variant=single-elimination` only reads the layout; `--variant=double-elimination` sends one result and asks to end the group stage early. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 29, 21, 6 and 9 |
| `npm run s18 -- --confirm` | S18: a whole two-stage event through BXQ itself, as S16 for one stage. Creates a tournament with 2 groups whose top 2 go to a final stage: `--groups=round-robin` (the default; 6 players, a double elimination final stage, and it also reads the tournament list), `--groups=swiss` (8 players, double elimination), `--groups=single-elimination` (8 players, single elimination, and it also reads the participant list for `group_id`) or `--groups=double-elimination` (8 players, single elimination), or `--groups=swiss-big` (12 players in 2 Swiss groups of 6, 4 advancing from each to a Swiss final stage of 8 players and 3 rounds). `--final=round-robin` or `--final=swiss` (2 rounds) replaces the variant's final stage. Then it drives the app in a browser: import through the review dialog, every group match on the pad, "End group stage", both kinds of Pass, "Start final stage", the final stage, Finalize, and a comparison with what Challonge holds. **Needs local Supabase and the built app running**, like S16, and puts a throwaway organizer in the local database. Screenshots go to `out/s18-shots-<groups>/`, or `out/s18-shots-<groups>-final-<final>/` | **Yes: the tournament it creates, and the local database** | 38 with round robin groups (30 by BXQ, 8 directly), 45 with Swiss groups (38 and 7), 34 with single elimination groups (26 and 8), 45 with double elimination groups (38 and 7), 32 with round robin groups and `--final=round-robin` or `--final=swiss` (24 and 8), 33 with single elimination groups and `--final=swiss` (25 and 8), 65 with `--groups=swiss-big` (58 and 7) |
| `npm run s21 -- --confirm` | S21: the two-stage cases S17 to S20 left untested, each in a tournament of round robin groups and a single elimination final stage. `--variant=three-groups` (the default; 9 players in 3 groups of 3), `--variant=unequal` (7 players in groups of 4) and `--variant=big-groups` (16 players in 2 groups of 8) read the layout only; `--variant=third-place` (6 players in 2 groups of 3) adds a third-place match to the final stage, plays group A to a three-way tie, and plays everything to Finalize. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 6, 6, 6 and 24 |
| `npm run s22 -- --confirm` | S22: a corrected result where no spike had tried one. `--variant=round-robin-final` (the default) plays 2 round robin groups of 3 and a round robin final stage, corrects a final-stage result, finalizes, then tries a correction on the finalized tournament; `--variant=swiss-final` corrects a round 1 result of a Swiss final stage once round 2 is paired; `--variant=bracket-group` corrects the first result of a double elimination group of 4 after the matches it fed were played. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 28, 21 and 14 |
| `npm run s19 -- --confirm` | S19: how a group that is a bracket ends. One run creates one tournament with a single group of 4 and 2 players advancing, and plays its group stage. `--variant=single-elimination` (the default) plays the first round, asks to end the group stage with the group's final unplayed, and reads the participant list during the group stage for `group_id`; `--variant=double-elimination` plays up to the losers final and asks to end the group stage with the grand final unplayed. Then resets and deletes it; `--keep` leaves it | **Yes, only on the tournament it creates** | 11 and 14 |
| `npm run s20 -- --confirm` | S20: a two-stage tournament whose final stage is a round robin or Swiss, which BXQ refused until this had run. One run creates one tournament of 6 players in 2 round robin groups of 3, 2 advancing, plays the groups, ends the group stage and starts the final stage: `--variant=round-robin` (the default) plays a round robin final stage to the end; `--variant=swiss` plays a Swiss final stage of 2 rounds, reading after each round whether the next is paired. Both finalize, then reset and delete it; `--keep` leaves it. First run on 2026-10-16: refused at its first request with 429 (500 requests per 30 days). Run again the same day with a second app of the same account, which had its own limit | **Yes, only on the tournament it creates** | 26 and 25 |

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
| With grand finals set to None, what becomes of the last-round matches, and can the tournament be finalized? | `summary-s14.json` → `last_round`, `finalize`, `standings` |
| How do consolation matches beyond third place appear? | `summary-s15.json` → `matches`, `outside_the_main_bracket` |
| Does a whole event run through BXQ end as it should on Challonge, at the cost the docs give? | `summary-s16-double-elimination.json`, `summary-s16-round-robin.json` and `summary-s16-swiss.json` → `checks`, `matches`, `finalize`, `requests_made_by_bxq`, `challonge` |
| What does a group stage look like in each format, and does a match say which group it is in? | `summary-s17-<variant>.json` → `group_stage` (`matches`, `match_attribute_keys`, `ids`) |
| What do ending the group stage and starting the final stage change? | `summary-s17-round-robin.json` → `after_groups`, `after_finalize_group_stage`, `final_stage` |
| Can a group result be corrected, and until when? | `summary-s17-swiss.json` → `correction_during_the_group_stage`, `correction_before_the_end`; `summary-s17-round-robin.json` → `correction`, `after_correction` |
| When does a Swiss group get its next round? | `fixtures/s17-swiss-matches-after-round-1.json` → each match's `created_at`, against the results in `requests.jsonl` |
| Who gets a `final_rank` in a two-stage tournament? | `summary-s17-round-robin.json` → `standings` |
| Does the tournament list say what the groups of a two-stage tournament play? | `summary-s18-round-robin.json` → `list_item` |
| Does a group that is a bracket have to be played to its last match before the group stage can end? | `summary-s19-single-elimination.json` → `early_finalize_group_stage`, `after_early_finalize`; `summary-s19-double-elimination.json` → `last_round`, `finalize_group_stage`, `after_finalize_group_stage` |
| Is a participant's `group_id` set in the participant list during a group stage? | `summary-s19-single-elimination.json` → `participant_list` |
| Does a whole two-stage event run through BXQ end as it should on Challonge, and at what cost? | `summary-s18-<groups>.json`, one for each of the four kinds of group → `checks`, `group_matches`, `between`, `final_matches`, `finalize`, `requests_made_by_bxq` |
| Is a participant's `group_id` set when there are two groups? | `summary-s18-single-elimination.json` → `participant_group_ids` |
| Does starting a round robin or Swiss final stage create its matches, and when, against `started_at`? | `summary-s20-<variant>.json` → `final_stage` (`matches_created`, `rounds`, `created_ms_after_started_at`) |
| Does a two-stage tournament with a Swiss final stage say how many rounds it has? | `summary-s20-swiss.json` → `created`, `final_stage` → `swiss_options` |
| Is a Swiss final stage paired one round at a time, and does it stop after its rounds? | `summary-s20-swiss.json` → `after_round_1`, `after_round_2` |
| Who gets a `final_rank` when the final stage is a round robin or Swiss? | `summary-s20-<variant>.json` → `standings` |
| Does a whole event with a round robin or Swiss final stage run through BXQ, and at what cost? | `summary-s18-round-robin-final-<final>.json`, `summary-s18-swiss-big.json` → `checks`, `final_matches`, `finalize`, `requests_made_by_bxq` |
| How are 3 groups, or groups of unequal size, laid out? | `summary-s21-three-groups.json`, `summary-s21-unequal.json` → `group_stage` |
| Where is a third-place match in a final stage, and when does it open? | `summary-s21-third-place.json` → `final_stage`, `after_semifinals` |
| Whom does Challonge let advance from a three-way tie, and how are those who didn't advance placed? | `summary-s21-third-place.json` → `after_finalize_group_stage`, `standings` |
| How are groups of 8 laid out, and what are their matches called? | `summary-s21-big-groups.json` → `group_stage` |
| What does a corrected result change in a round robin or Swiss final stage? | `summary-s22-round-robin-final.json`, `summary-s22-swiss-final.json` → `correction`, `after_correction` |
| Does Challonge take a correction once a tournament is finalized? | `summary-s22-round-robin-final.json` → `correction_after_finalize`, `after_late_correction` |
| Does a corrected winner in a group that is a bracket reset the matches it fed? | `summary-s22-bracket-group.json` → `before_correction`, `correction`, `after_correction` |
