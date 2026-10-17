# BXQ brand guide

How the app is named and how it talks. Follow this in UI copy, documentation, onboarding and metadata.

## Name

| | |
|---|---|
| **Name** | BXQ |
| **Meaning** | "BX", Takara Tomy's product line code for Beyblade X, plus "Q" for queue |
| **Tagline** | Your stadium is ready. |
| **Former name** | Stadium Control (a placeholder; don't use it) |

The name and tagline live in `lib/config.ts` as `APP_NAME` and `APP_TAGLINE`. Read them from there instead of typing them into a component.

## Tone

Community-first and true to blader culture: fast, direct, and built for running a floor at esports pace. Say what happens and what to do next. Use the words bladers use ("On deck", "In the hole", "You're up").

## Who it's for

| Audience | What they need |
|---|---|
| **Organizers (TOs)** | A calm arena desk: the bracket, the stadium lanes and the queue in one place, with nothing else to sign up for. |
| **Judges** | Fast scoring on a tablet, in the dark of a venue, with no organizer sign-in on the device. |
| **Players (bladers)** | A private, self-serve view of their own queue position, and a push the moment they're called to a stadium. |

## The four screens

| Name | What it is | Route |
|---|---|---|
| **BXQ Desk** | The organizer's control room: stadium cards, queue controls, automatic or manual on deck, recall timers, device sync banners, passcode management and slip printing. Before the start, the players and seeds; once started, a link to the whole bracket. | `(control)/tournaments/[id]`, bracket at `/tournaments/<id>/bracket` |
| **BXQ Board** | The TV display for spectators and the floor: pairing-code approval, chimes, spoken calls, live scores, "In the hole", QR codes, and the final standings once the tournament is finished. | `/t/<slug>/board`, short link `/b/<code>` |
| **BXQ Pad** | The judge's scoring tablet: tablet-first, always dark, taps cached offline in IndexedDB. A judge pairs by short code and the Desk approves, or the organizer uses "Judge here myself". No judge, no start; a called match is started on the pad. | `/j/<code>` to sign up |
| **BXQ Pass** | The player's page: an installable PWA with web push ("On deck", "You're up"), opened with a 4-digit passcode or the QR code on a personal slip. Shows only that player's match status, placement and battle-by-battle scores. | `/t/<slug>` |

### Writing the names

- **Titles, headings and first mentions** use the full name: "BXQ Desk", "BXQ Board", "BXQ Pad", "BXQ Pass".
- **Buttons, counts and later mentions** use the short form: "Open pad", "Disconnect pad", "Boards allowed", "Back to the Desk", "Open my Pass".
- **"Desk" and "Pass" keep their capital** in the short form, because the plain words mean something else. "board" and "pad" are ordinary nouns and stay lower case mid-sentence.
- **Don't use the old names** in copy: "control room", "call board", "judge pad", "player page", "My match".
- **Code is exempt.** Comments, identifiers and file names (`control-room.ts`, `JudgePad`, `call-board.tsx`) keep their existing names.

## Technical pillars

Changes should keep these true.

- **Our own bracket engine.** Single and double elimination, round robin, Swiss and two-stage tournaments are built and run by BXQ itself (`lib/bracket/`), pure and unit-tested. No outside bracket service, account or API key.
- **The server decides.** A result is recorded on the server in one transaction: the winner moves on, the next Swiss round is paired, and the queue is planned again. Devices only show what the server says.
- **Two ways to stay live.** The Desk and boards listen on Supabase Realtime and fall back to a poll every 60 seconds. Player phones poll every 10 seconds and rely on web push for the call itself.
- **Offline-first on the floor.** A service worker caches pads, and IndexedDB records every battle tap on the device. A match finished offline is saved when the connection returns.
