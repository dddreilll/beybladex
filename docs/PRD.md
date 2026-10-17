# BXQ product requirements

What BXQ is for, who uses it, and what it has to do. How it is built is in [ARCHITECTURE.md](ARCHITECTURE.md); how it looks is in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md); the name and tone are in [brand.md](brand.md). Why BXQ runs its own brackets, and the record of that change, is in [rfc-002-own-bracket-engine.md](rfc-002-own-bracket-engine.md). How it was first built, on Challonge, is kept in [rfc-001-architecture.md](rfc-001-architecture.md).

## Vision

Every Beyblade X community can run its floor at esports pace: players know where to be, judges score in one tap, and the bracket is never behind.

## Mission

Give organizers one place to run a Beyblade X tournament, from the list of players to the final standings. BXQ builds the bracket, runs the stadium queues and the player calls, scores every battle, and moves the bracket on the moment a match ends. Nothing else to sign up for, and no outside service to keep in step.

## The problem

A local tournament is usually run with a megaphone, a paper list and one laptop open on a bracket site.

- **Players miss their call,** or crowd the desk to ask when they play.
- **Scores travel on paper** from the stadium to the desk, and are typed into the bracket later, sometimes wrongly.
- **Bracket sites only store a total per set.** They have no notion of Spin, Over, Burst or Xtreme finishes, so the battle record is lost.
- **The venue Wi-Fi drops,** and scoring stops with it.
- **A bracket site and a floor app have to be kept in step,** and an outside API brings limits of its own: Challonge's free tier allows 500 requests a month.

## Who it's for

| Persona | What they need | What BXQ gives them |
|---|---|---|
| **Organizers (TOs)** | A calm desk: the bracket, every stadium and the queue in one place. | **BXQ Desk**: players and seeds before the start, then stadium cards, the queue, automatic or manual on deck, recalls, drops, the whole bracket on its own page, approval of boards and judge tablets, passcodes and printed slips. |
| **Judges** | Fast scoring on a tablet, in a dark and noisy venue, with a connection that comes and goes. No organizer account on the device. | **BXQ Pad**: one tap per finish, Undo, and a pad that keeps working offline. A judge pairs with a short code and the organizer approves the tablet. |
| **Players (bladers)** | To know when and where they play without watching a screen, and to see only their own matches. | **BXQ Pass**: opened with a 4-digit passcode or the QR code on a personal slip. It shows their queue position, sends a push when they are on deck and when they are up, and lists their finished matches battle by battle. |

Spectators and the whole floor share a fourth screen, **BXQ Board**, on a TV.

## The four screens

| Screen | For | Where | What it does |
|---|---|---|---|
| **BXQ Desk** | Organizers | `/tournaments/<id>` | Before the start, the players and seeds. Then the floor dashboard: stadium cards with live scores and, in tabs under them, the queue, on-deck and call controls, recalls, drops, device banners, access approval, passcodes and slip printing, and a link to the whole bracket. |
| **BXQ Board** | Spectators and the floor | `/t/<slug>/board`, short link `/b/<code>` | A TV display approved by pairing code. "Now calling" with a chime and a spoken call, live scores, "In the hole", standings, a QR code to the Pass, and the final standings. |
| **BXQ Pad** | Judges | `/j/<code>` to sign up | Tablet-first, always dark scoring. Taps are stored on the device and synced when there is a connection. |
| **BXQ Pass** | Players | `/t/<slug>` | An installable page with web push. Shows one player's status, their own matches, placement and scores. |

## Requirements

Everything below is built. The README lists the same features, and the RFCs record how each was decided.

### Tournaments and brackets

- **Create a tournament** on the New tournament page: a name, a format, the options of that format, and the players in seed order. Players can be typed one at a time or pasted many at once, separated by commas or new lines.
- **Formats:** single elimination (optional third-place match), double elimination (grand final with a reset, or a single grand final), round robin (each pair meets once or twice) and Swiss (the suggested number of rounds, or the organizer's).
- **Two-stage tournaments:** a group stage, then a final stage. The groups and the final stage can each be any of the four formats. The organizer sets how many groups and how many of each go through. Players are spread over the groups by snake seeding.
- **Players and seeds before the start:** add one or many, rename, move up or down, remove, or shuffle the seeds. Fixed once the tournament starts.
- **Start tournament** builds the bracket or the groups and fills the queue. It asks first.
- **Results move the bracket on** as soon as the judge confirms: the winner, and in double elimination the loser, go to their next matches, and the next Swiss round is paired once a round is played.
- **Corrections:** a corrected winner that would erase later results lists them and asks first. Erased battles are voided, never deleted.
- **Standings** for a round robin, Swiss, every group, and a round robin or Swiss final stage: wins, then Buchholz, then head-to-head, then Beyblade X points difference, then seed. On the Desk, and taking turns with "In the hole" on the board. Never on a Pass.
- **End group stage, then Start final stage,** as two steps, so the organizer sees who goes through in between. Group winners are seeded first, then runners-up, and players from the same group are kept apart in the first round where possible.
- **Drop a player:** their open matches, and any they would have reached, go to their opponents as forfeits. Their results stand and they keep their Pass.
- **Late players** can join a running Swiss, from its next round.
- **Finish tournament** once the final stage is played out: every player gets their place. The board shows the final standings and each Pass the player's place.
- **The Bracket tab** on the Desk shows the organizer every round of every group and stage, with byes as gaps and the winner of each match marked. A match with both players opens its pad.
- **Match numbers:** one number per match across the whole tournament, in the order the queue plays them. "M12" on the Desk, "Match 12" on the board, the pad, notifications and the Pass.
- **Desk tabs:** the stadium cards stay on top; Queue, Standings, Players, Completed and Bracket are a vertical menu under them, with the open tab beside it, so the Desk doesn't scroll forever.
- **Delete a tournament,** with everything in it, after typing its name.

### Rules and scoring

- **Rule profiles:** 4 presets (First to 4, First to 4 with best-of-3 finals, First to 5, First to 7) plus the organizer's own. A profile sets the points per finish, the target, best-of sets, a finals override, the launch-error penalty, own finish, and whether scores are capped at the target.
- **BXQ Pad:** one tap per finish, Undo, draw, launch error. Every tap is saved per battle, is safe to send twice, and is retried. The screen stays awake. A called match is started on the pad.
- **Battle scores of finished matches:** on the Desk for any match, and on the Pass for the player's own matches.

### The floor

- **Stadium lanes on the Desk:** Now and On deck per stadium, in the bracket's play order. Call, Start, Hold, Cancel, Back to queue, Move to, and adding, renaming and removing stadiums.
- **Two switches:** "Fill on deck automatically" and "Call automatically".
- **Recall players:** "Second call", "Third call" and so on, on the board and by push, with a 15-second cooldown.
- **BXQ Board** for a TV: "Now calling", live scores, "In the hole", a QR code. Calls play a chime and are spoken aloud.
- **Web push:** "On deck at Stadium 2", then "You're up at Stadium 2", even with the page closed. Players opt in on their Pass, which can be installed.
- **Judge tablets:** a judge picks a stadium and the organizer approves the tablet. It can score only the match at its stadium. One judge per stadium; "Judge here myself" lets an organizer run an event alone. No judge, no start.
- **Short links:** `/b/<code>` opens the board and `/j/<code>` the pad sign-up.

### Offline on the floor

- **Offline pad:** taps are stored in IndexedDB on the tablet and sync when the connection returns. A lost connection, a reload or a crashed tab loses nothing.
- **Offline results:** a match finished offline is saved automatically once the tablet is back online.
- **Pads that open offline:** a service worker caches pad pages, and the Desk pre-loads the pads of matches at stadiums.
- **Device banner:** the Desk lists anything still only on this device, and why.

### Access

- **Organizer sign-in** by magic link, invite-only: `npm run invite -- <email>` grants access.
- **Boards need approval,** with a limit per tournament (1 by default, up to 10), a live count of open boards, and Disconnect.
- **Player passcodes:** each player signs in with a 4-digit passcode or the QR code on their slip, on one device at a time. Wrong passcodes lock the guessing device first.
- **Players see only their own matches.** The server sends each phone that player's data and nothing else.
- **A screen that closes says so:** a board, a judge tablet or a Pass shows as closed on the Desk within seconds.

### The public site

- **Landing page, Terms of Service, Privacy Policy, and a "Request Early Access" button** for organizers who don't have access yet.

## Milestones

| Milestones | What they delivered | Record |
|---|---|---|
| RFC-001, M1 to M6 and after | BXQ on top of Challonge: the Desk, the pad, the board and the Pass, offline scoring, push, access, judge tablets, every format and two-stage tournaments, all reported to Challonge | [RFC-001](rfc-001-architecture.md) |
| RFC-002, M1 | The engine core: single elimination and round robin | [RFC-002](rfc-002-own-bracket-engine.md) |
| RFC-002, M2 | Double elimination and corrections in the engine | |
| RFC-002, M3 | Swiss, standings with tie-breaks, placements, two-stage seeding | |
| RFC-002, M4 | The app runs on the engine; Challonge removed | |
| RFC-002, M5 | Creating and setting up tournaments on the Desk; drops and late players | |
| RFC-002, M6 | The bracket page; landing page, legal pages and documents without Challonge | |
| RFC-002, M7 | Match numbers across the tournament instead of letters; tabs on the Desk, with the bracket as one of them | |

## Constraints

These hold for every change. The technical pillars at the end of [brand.md](brand.md) say the same from the engineering side.

| Constraint | Requirement |
|---|---|
| **The server decides** | Brackets are built and moved on by BXQ's server, in one transaction per change. No device works out a bracket. |
| **Offline scoring** | Anything a judge does on the pad works without a connection and loses nothing. |
| **No accounts for players or judges** | A player needs a passcode or a QR code; a judge needs a pairing code and the organizer's approval. |
| **Privacy** | A player's phone receives that player's matches only. Boards and tablets show nothing until the organizer approves them. |
| **Trademarks** | No official Beyblade, Takara Tomy or Hasbro logos or artwork. |

## Not in scope

- **Importing from, or exporting to, Challonge or another bracket site.** Tournaments are created in BXQ, and their results stay there.
- **A public bracket page.** The bracket is for the organizer, on the Desk; the board shows calls and standings, and a Pass a player's own matches.
- **Free for all,** with more than two players in a match.
- **Open sign-up, billing and teams.** Access is by invitation.
- **Native apps.** The Pass and the pad are web pages that can be installed.

## Known limits and open items

Candidates for later work, not a committed roadmap.

| Area | Limit |
|---|---|
| Formats | Only a third-place match separates places in a single elimination bracket: other players knocked out in the same round share a place (5th, 7th and so on). The pad never records a tie: a draw is replayed. Groups use the tournament's options (grand final, legs) and, in Swiss, the suggested number of rounds for their size. Late players can join a Swiss only. |
| Setup | Players and seeds are fixed at the start. A bracket can't be edited by hand after it, and a Swiss pairing can't be overridden. |
| Tournaments from Challonge | Every tournament imported from Challonge was deleted when BXQ moved to its own engine (RFC-002). There is no way to bring one in. |
| Offline | A pad never opened or pre-loaded on a device can't be opened offline. Syncing needs BXQ open in a tab. The judge's waiting screen needs a connection; only the pad works offline. |
| Offline and Cancel | Taps still unsent on a tablet when its match is cancelled sync later and reappear on the cancelled match. |
| Players | On an iPhone, Safari and the home-screen app are two devices, so installing the Pass means signing in again. Someone who clears their cookies between guesses is held back only by the limit of 60 wrong tries an hour for the player, so a determined guesser could lock a player's typed sign-in for up to an hour; the QR code and "New passcode" get around it. |
| Boards | A board, a judge tablet or a Pass on a device that dies without closing its tab still shows as open for up to 150 seconds. |
| Desk | A match is moved between stadiums with Move to; nothing on the Desk is dragged. Only an on-deck match can be moved, and only to an empty on-deck slot. |
| Push | Delivery to a real device isn't checked by the automated tests. |
| Legal pages | The Terms of Service and Privacy Policy are drafts and need a legal review before anyone relies on them. |
