# BXQ product requirements

What BXQ is for, who uses it, and what it has to do. How it is built is in [ARCHITECTURE.md](ARCHITECTURE.md); how it looks is in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md); the name and tone are in [brand.md](brand.md). The decisions behind the design, and the record of each milestone, are in [rfc-001-architecture.md](rfc-001-architecture.md).

## Vision

Every Beyblade X community can run its floor at esports pace: players know where to be, judges score in one tap, and the bracket is never behind.

## Mission

Give organizers floor coordination on top of the bracket they already run on [Challonge](https://challonge.com). Challonge stays the bracket of record. BXQ adds what Challonge doesn't have: stadium queues, player calls, battle-by-battle scoring and a venue display.

BXQ does not replace Challonge and does not keep a second bracket. Its own database holds the live state of the floor (the queue, the calls, each battle), and every finished match is written through to Challonge.

## The problem

A local tournament is usually run with a megaphone, a paper list and one laptop open on Challonge.

- **Players miss their call,** or crowd the desk to ask when they play.
- **Scores travel on paper** from the stadium to the desk, and are typed into Challonge later, sometimes wrongly.
- **Challonge only stores a total per set.** It has no notion of Spin, Over, Burst or Xtreme finishes, so the battle record is lost.
- **The venue Wi-Fi drops,** and scoring stops with it.
- **Challonge's free API tier allows 500 requests a month,** so an app that polls it from every screen is cut off within one event.

## Who it's for

| Persona | What they need | What BXQ gives them |
|---|---|---|
| **Organizers (TOs)** | A calm desk: every stadium and the queue in one place, with no risk of running out of Challonge requests in the middle of an event. | **BXQ Desk**: stadium cards, the queue, automatic or manual on deck, recalls, approval of boards and judge tablets, passcodes and printed slips. A meter in the side navigation shows the month's Challonge requests. |
| **Judges** | Fast scoring on a tablet, in a dark and noisy venue, with a connection that comes and goes. No organizer account on the device. | **BXQ Pad**: one tap per finish, Undo, and a pad that keeps working offline. A judge pairs with a short code and the organizer approves the tablet. |
| **Players (bladers)** | To know when and where they play without watching a screen, and to see only their own matches. | **BXQ Pass**: opened with a 4-digit passcode or the QR code on a personal slip. It shows their queue position, sends a push when they are on deck and when they are up, and lists their finished matches battle by battle. |

Spectators and the whole floor share a fourth screen, **BXQ Board**, on a TV.

## The four screens

| Screen | For | Where | What it does |
|---|---|---|---|
| **BXQ Desk** | Organizers | `/tournaments/<id>` | The floor dashboard: stadium cards with live scores, the queue, on-deck and call controls, recalls, device banners, access approval, passcodes and slip printing. |
| **BXQ Board** | Spectators and the floor | `/t/<slug>/board`, short link `/b/<code>` | A TV display approved by pairing code. "Now calling" with a chime and a spoken call, live scores, "In the hole", a QR code to the Pass, and the final standings. |
| **BXQ Pad** | Judges | `/j/<code>` to sign up | Tablet-first, always dark scoring. Taps are stored on the device and synced when there is a connection. |
| **BXQ Pass** | Players | `/t/<slug>` | An installable page with web push. Shows one player's status, placement and scores. |

## Requirements

Every milestone below is built. The README lists the same features release by release, and the RFC records how each one was decided.

### M1: accounts, Challonge connection, import

- **Organizer sign-in** by magic link. Sign-in is invite-only: sign-ups are off, and `npm run invite -- <email>` grants access.
- **Bring-your-own Challonge OAuth app.** Each organizer creates an app in Challonge's Developer Portal and pastes its client ID and secret into BXQ. The secret and the tokens are encrypted at rest with AES-256-GCM, never reach the browser, and refresh automatically.
- **Tournament import** in 3 Challonge requests, and **Resync** in 2 when nothing changed.
- **Request budget meter.** BXQ counts every Challonge request itself, including 304 answers and token calls, and shows the month's total per organizer.

### M2: rules and scoring

- **Rule profiles:** 4 presets (First to 4, First to 4 with best-of-3 finals, First to 5, First to 7) plus the organizer's own. A profile sets the points per finish, the target, best-of sets, a finals override, the launch-error penalty, own finish, and whether scores are capped at the target.
- **BXQ Pad:** one tap per finish, Undo, draw, launch error. Every tap is saved per battle, is safe to send twice, and is retried. The screen stays awake.
- **Results to Challonge:** 2 requests per result (1 in a round robin). BXQ checks that Challonge really applied the result, because Challonge can answer 200 and ignore it.
- **Corrections:** before sending a correction that would erase matches already played, the Desk lists them and asks for confirmation. A send that failed can be retried from the Desk.

### M3: stadiums, the board and the Pass

- **Stadium lanes on the Desk:** Now and On deck per stadium, in Challonge's suggested play order. Call, Start, Hold, and adding, renaming and removing stadiums.
- **BXQ Board** for a TV: "Now calling", live scores, "In the hole", a QR code. Calls play a chime and are spoken aloud.
- **BXQ Pass:** a player sees whether they are called, on deck, queued or waiting, and it updates by itself.
- **Live updates never cost a Challonge request.** Screens poll BXQ's own server; the Desk and boards also listen on Supabase Realtime.

### M4: push for players

- **Web push:** "On deck at Stadium 2", then "You're up at Stadium 2", even with the page closed. Players opt in on their Pass.
- **Installable Pass:** each tournament has its own manifest, so "Add to Home Screen" opens that tournament's Pass. On iPhone, notifications work only after this step.

### M5: offline on the floor

- **Offline pad:** taps are stored in IndexedDB on the tablet and sync when the connection returns. A lost connection, a reload or a crashed tab loses nothing.
- **Offline results:** a match finished offline is sent to Challonge automatically once the tablet is back online.
- **Pads that open offline:** a service worker caches pad pages, and the Desk pre-loads the pads of matches at stadiums.
- **Device banner:** the Desk lists anything still only on this device, and why.

### After M5: Desk redesign and queue controls

- **Recall players:** re-announces a called match as "Second call", "Third call" and so on, on the board and by push, with a 15-second cooldown.
- **Two switches:** "Fill on deck automatically" and "Call automatically". With filling off, the organizer places matches from the queue.
- **Back to queue, Hold and Cancel.** Hold keeps the recorded battles; Cancel voids them and restarts the match at 0–0.

### M6: finals and access

- **Finalize tournament** from the Desk once every match is played and sent. About 4 Challonge requests; it can't be undone on Challonge. The board then shows the standings, and each player sees their placement.
- **Boards need approval.** A screen shows a pairing code until the organizer approves it. There is a limit per tournament (1 by default, up to 10), a live count of open boards, and Disconnect.
- **Player passcodes.** Each player signs in with a 4-digit passcode or the QR code on their slip, on one device at a time. The Desk lists passcodes, issues new ones and prints the slips.
- **Players see only their own match.** The server sends each phone that player's data and nothing else.

### After M6

- **Battle scores of finished matches:** on the Desk for any match, and on the Pass for the player's own matches.
- **Short links:** a 6-character code per tournament; `/b/<code>` opens the board and `/j/<code>` the pad sign-up.
- **Judge tablets:** a judge picks a stadium and the organizer approves the tablet. It can score only the match at its stadium, and follows that stadium from match to match. One judge per stadium. "Judge here myself" lets an organizer run an event alone.
- **No judge, no start:** a called match can't start until its stadium has a judge, and it is started with a "Start match" button on the pad.
- **Light mode on the Desk:** it now follows the light/dark switch like the other organizer pages. The venue screens stay dark.
- **Import review:** importing asks first. A dialog shows the tournament's name, format, grand finals or third-place match, player count and status, with a link to it on Challonge, and the organizer confirms. An import is still 3 Challonge requests.
- **Supported formats:** single elimination, double elimination and round robin. Swiss, free for all and two-stage tournaments are refused before the review, with the reason. If an imported tournament later becomes one of those, Resync and Finalize refuse and the Desk says why.
- **Round robin:** every match is ready from the start, and no round is a final. A result costs 1 request, because nothing else in the tournament changes with it. A corrected winner erases nothing, so the pad doesn't ask first. A tie entered on challonge.com shows as a tie; the pad still never sends one.
- **Landing page, Terms of Service, Privacy Policy, and a "Request Early Access" button** for organizers who don't have access yet.

## Constraints

These hold for every change. The technical pillars at the end of [brand.md](brand.md) say the same from the engineering side.

| Constraint | Requirement |
|---|---|
| **Challonge request budget** | A whole event fits in Challonge's free 500 requests a month. Boards, pads and player phones never call Challonge. |
| **Bring-your-own credentials** | Every organizer uses their own Challonge app, so every organizer has their own budget. BXQ holds no shared Challonge key. |
| **Offline scoring** | Anything a judge does on the pad works without a connection and loses nothing. |
| **No accounts for players or judges** | A player needs a passcode or a QR code; a judge needs a pairing code and the organizer's approval. |
| **Privacy** | A player's phone receives that player's matches only. Boards and tablets show nothing until the organizer approves them. |
| **Trademarks** | No official Beyblade, Takara Tomy or Hasbro logos or artwork. |

### What an event costs in Challonge requests

| Action | Requests |
|---|---|
| List the organizer's Challonge tournaments (optional) | 1 |
| Import a tournament | 3. By link or ID: 1 to review it, 2 to import it. |
| A review, import or resync refused for the tournament's format | 1 |
| Resync, nothing changed | 2 |
| Send a result | 2 in a bracket, 1 in a round robin |
| Mark a match underway on Challonge (optional, per match) | 1 |
| Finalize | about 4 |

A 32-player double-elimination bracket has about 63 matches, so about 130 requests, or about 190 with every match marked underway. That is 2 to 3 events a month on the free tier. A 16-player round robin has 120 matches, so about 130 requests. The figures come from the spikes in the RFC.

## Not in scope

- **A bracket engine.** Seeding, pairing and progression stay on Challonge.
- **Live scores on Challonge during a match.** Challonge accepts them, but each update costs a request.
- **A conflict screen** ("Keep ours / Use Challonge") and **check-in status.** Both were in the first mockups and were left out on purpose.
- **Open sign-up, billing and teams.** Access is by invitation.
- **Native apps.** The Pass and the pad are web pages that can be installed.

## Known limits and open items

Recorded in the RFC as each milestone was finished. They are candidates for later work, not a committed roadmap.

| Area | Limit |
|---|---|
| Formats | Single elimination, double elimination and round robin are imported. Swiss works on Challonge's side (spikes S7 to S11 in the RFC), but it is refused until BXQ handles its rounds, which Challonge pairs after it has answered the last result, and players who drop out. A round robin has no running standings in BXQ, and something changed on challonge.com during one shows only after Resync. Free for all (matches of more than two players) and two-stage tournaments don't fit BXQ's one-against-one matches in one bracket. Within the supported formats, consolation matches (third place, and fifth and seventh where the bracket has them) are queued after the final, as Challonge orders them. With grand finals set to None, a rule profile's finals rules apply to no match. Results can still be sent for a tournament imported before formats were checked. |
| Finalize | A real finalize from BXQ has run once, at the end of a 4-player double elimination event (spike S16 in the RFC). The automated tests still use the fake Challonge. Whether Challonge accepts a correction after finalizing is untested. A result BXQ failed to send keeps Finalize blocked until it is sent again from BXQ, even if the match was completed on challonge.com in the meantime. |
| Budget | It is not known whether Challonge counts 304 answers and token calls. BXQ counts them all, so its meter may read high. |
| Offline | A pad never opened or pre-loaded on a device can't be opened offline. Syncing needs BXQ open in a tab. The judge's waiting screen needs a connection; only the pad works offline. |
| Offline and Cancel | Taps still unsent on a tablet when its match is cancelled sync later and reappear on the cancelled match. |
| Players | On an iPhone, Safari and the home-screen app are two devices, so installing the Pass means signing in again. Anyone at the venue can lock a player's typed sign-in for up to 10 minutes with wrong guesses; the QR code and "New passcode" get around it. |
| Boards | A closed board still shows "Open now" for up to 150 seconds. |
| Desk | A match can't be dragged from one stadium to another. |
| Push | Delivery to a real device isn't checked by the automated tests. |
| Legal pages | The Terms of Service and Privacy Policy are drafts and need a legal review before anyone relies on them. |
