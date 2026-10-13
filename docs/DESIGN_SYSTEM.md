# BXQ design system

How BXQ looks and behaves on screen. This describes the tokens and patterns the app ships; the tokens themselves are in [app/globals.css](../app/globals.css) and [tailwind.config.ts](../tailwind.config.ts). The name, the tone of voice and the screen names are in [brand.md](brand.md).

## Identity

| | |
|---|---|
| **Name** | BXQ (`APP_NAME` in `lib/config.ts`) |
| **Tagline** | Your stadium is ready. (`APP_TAGLINE`) |
| **Look** | An arena at night: dark surfaces, and lime as the single action accent. |

BXQ uses its own name and identity. No official Beyblade, Takara Tomy or Hasbro logos or artwork.

## Themes

The app has a light and a dark theme, switched with `next-themes` (the `dark` class on `<html>`). Dark is the default.

| Screens | Theme |
|---|---|
| Landing page, sign-in, Terms and Privacy, Tournaments, Rules, Challonge connection, **BXQ Desk** | The selected theme. The switch is in the side navigation. |
| **BXQ Board**, **BXQ Pad**, **BXQ Pass**, the pad sign-up and both pairing screens | Always dark |

The venue screens are read on a TV across a hall or on a tablet in low light, so they wrap their content in an element with the `dark` class (see `app/t/[slug]/page.tsx`). A new venue screen does the same.

`color-scheme` is set together with the tokens, so native controls, pop-up lists and scrollbars match the theme, including on an always-dark screen under a light root.

## Colour tokens

Colours are HSL custom properties, exposed to Tailwind under the same names (`bg-background`, `text-muted-foreground`, `border-border`). Use the tokens; don't write a hex value where a token exists.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `background` | `#F6F7F9` | `#0B0E13` | The page |
| `foreground` | `#12161C` | `#EFF2F6` | Body text |
| `card`, `popover` | `#FFFFFF` | `#161B22` | Cards, dialogs, menus |
| `primary` | `#C8F561` | `#C8F561` | Filled buttons, "Now calling", the active state |
| `primary-foreground` | `#0B0E13` | `#0B0E13` | Text on a lime fill |
| `primary-text` | `#506B0F` | `#C8F561` | The accent as text or as an outline |
| `secondary`, `muted`, `accent` | `#EAECF1` | `#1E242E` | Quiet fills, hover |
| `muted-foreground` | `#555F6D` | `#9AA4B1` | Secondary text, labels |
| `border`, `input` | `#D5DAE2` | `#2B3340` | Lines and field outlines |
| `ring` | `#12161C` | `#C8F561` | The focus ring |
| `destructive` | `#C32222` | `#BA2C2C` | Removing, cancelling, the budget meter from 90% |
| `success` / `success-muted` | `#1F7A40` / `#E1F4E8` | `#9DE7B6` / `#173020` | "Live", sent, connected |
| `warning` / `warning-muted` | `#975D0C` / `#FDF1D8` | `#FCD78D` / `#372810` | Offline, waiting, the budget meter from 70% |

### Using the accent

Lime can't be read as text on white. The accent therefore has two tokens.

- **A filled control** uses `bg-primary text-primary-foreground`. It is the same in both themes.
- **Accent-coloured text or an outline** uses `text-primary-text` or `border-primary-text`: lime in dark mode, a dark green of the same hue in light mode (6.1:1 on white).

Keep lime for the one thing on a screen that should be acted on or looked at: the primary button, the match being called, the current navigation entry.

### Finish colours

Each finish keeps its hue everywhere it appears. A finish is never shown by colour alone: it always has its label and its icon.

| Finish | Icon (Lucide) | On dark | On light |
|---|---|---|---|
| Spin | `RotateCw` | `#8EB1FF` | `#1D4ED8` |
| Over | `ArrowUpFromLine` | `#FBC54A` | `#92400E` |
| Burst | `Sparkles` | `#FF8A8A` | `#B91C1C` |
| Xtreme | `Zap` | `#C9B6FF` | `#6D28D9` |
| Own finish | `CircleSlash` | `#C4CBD6` | Not used: it appears only on the pad, which is always dark |

The pastel shades are for dark backgrounds. In light mode a chip uses the darker shade on a tint of the same hue (`rules-picker.tsx`).

### Other fixed colours

- **The two sides of a stadium** on the pad: player 1 `#2DD4BF`, player 2 `#F472B6`.
- **The podium** on the board: gold `#E8B923`, silver `#B9C2CF`, bronze `#C98A52`.
- **The board's own surfaces:** page `#07090D`, cards `#11151B` with a `#232A35` outline. They are darker than the dark theme, for contrast on a TV.

## Typography

Both typefaces are loaded with `next/font` in `app/layout.tsx`.

| Role | Typeface | Tailwind | Used for |
|---|---|---|---|
| Body | Barlow (400, 500, 600, 700) | `font-sans` | Text, labels, tables, buttons |
| Display | Chakra Petch (500, 600, 700) | `font-display` | Page titles, player names, stadium names, scores |

- Scores and counts use `tabular-nums`, so digits don't shift as they change.
- Small labels over a value ("NOW", "ON DECK", "IN THE HOLE") are bold, upper case and letter-spaced, in `text-muted-foreground`.

## Shape and icons

- **Radius:** `--radius` is 0.875rem (`rounded-lg`); `rounded-md` and `rounded-sm` step down from it. The venue screens use `rounded-xl` to `rounded-3xl` on their large buttons and cards.
- **Icons:** [Lucide](https://lucide.dev) through `lucide-react`. An icon inside a button is 16px (`size-4`, set by the button). An icon that only repeats its label gets `aria-hidden`.

## Components

The base is [shadcn/ui](https://ui.shadcn.com) in the "new-york" style with CSS variables. The components are copied into `components/ui/` and belong to this repo: `badge`, `button`, `card`, `checkbox`, `dropdown-menu`, `input`, `label`, `select`, `tooltip`.

| Component | Notes |
|---|---|
| `Button` | Variants `default` (lime fill), `secondary`, `outline`, `ghost`, `destructive`, `link`. Sizes `sm` 32px, `default` 36px, `lg` 40px, `icon` 36px. These sizes are for the organizer pages; see the venue screens below. |
| `Select` | Use it instead of a native `<select>`. A native list is drawn in the root's colour scheme and becomes unreadable on an always-dark screen under a light root. |
| `Tooltip` | Short hints such as "Click to copy". |
| `PageShell` (`components/page-shell.tsx`) | The header of every signed-in page: the menu button, a title with an optional subtitle, and page items on the right. |
| `SideNav` (`components/side-nav.tsx`) | Opens from the left over the page. Holds the sections, the budget meter, the theme switch and Sign out. |
| `BudgetMeter` | Lime below 70% of the month's requests, `warning` from 70%, `destructive` from 90%. |

Add a shadcn component with its CLI, then adapt it. The organizer pages use this kit as it is. The pad and the board are designed by hand, because those two screens are what the product is for.

## Patterns by screen

### BXQ Desk: laptop or tablet, dense

- A header row, then Stadiums and the Queue on the left and a sidebar on the right.
- One card per stadium, with Now (players, live score, latest battle) and On deck.
- A button appears only when it can act; otherwise a status line says what happens next.
- Actions that erase something (Cancel match, a correction that wipes later matches) ask first and say exactly what will be lost.

### BXQ Pad: tablet, low light, fast taps

| Element | Minimum height |
|---|---|
| Finish buttons | 96px (`min-h-24`) |
| Start match, Undo last | 64px (`min-h-16`) |
| The buttons of the result dialog | 56px (`min-h-14`) |
| Draw, Launch error, Swap sides, Review & submit | 48px (`min-h-12`) |
| The back link | 44px (`min-h-11`) |

- The screen is split into two halves that match the physical sides of the stadium, with "Swap sides". Each half carries its side's colour.
- The running score is the largest thing on the screen (`text-7xl`, `text-8xl` from the `sm` breakpoint).
- A finish button shows its icon, its points and its name.
- **Undo instead of confirmation.** A tap is never confirmed; "Undo last" is always in reach. The pad asks once, before the result is sent.
- Every tap gives feedback at once: the button scales down (`active:scale-[0.97]`) and the tablet vibrates briefly. Nothing waits for the server.
- The screen is kept awake with the Screen Wake Lock API.
- A status pill in the header always says where the taps are: "Saved", "Saving…", or "Offline · 3 saved on this device".

### BXQ Board: a TV read from 3 to 5 metres

- Type and spacing scale with the screen: sizes are `clamp()` values in `vw`, and gaps are in `vw` and `vh`. The names in the "Now calling" banner are `clamp(2rem, 5vw, 6.5rem)`.
- The banner is a lime fill with dark text, the one place a whole block is lime.
- A new call plays a chime and is spoken aloud. Browsers block sound until someone taps, so the board has an "Enable sound" button.
- It needs no mouse or keyboard after that. The only other control is Full screen.
- A QR code to the Pass sits on a light panel, so cameras can read it.

### BXQ Pass: a player's own phone

- One column, at most 28rem wide (`max-w-md`), with 20px of padding.
- The stadium name is in display type, and the status in the words bladers use ("On deck", "You're up").
- Tap targets are at least 44px high.
- The phone vibrates when the player is called while the page is open; a push covers the rest.

## Accessibility

- **Contrast:** text meets WCAG AA in both themes. `tests/e2e/theme.e2e.mjs` measures the accent text, the chips, the menus and the dropdown lists against their backgrounds.
- **Focus:** every focusable element shows a ring (`ring-2 ring-ring ring-offset-2`), set once in `globals.css`.
- **Touch targets:** 44px or more on the venue screens, and 96px for the pad's finish buttons.
- **Colour is never the only signal:** finishes have labels and icons, and states have words ("Live", "Reconnecting…", "Offline").
- **Motion:** the landing page's animation shows a still image to people who ask for reduced motion.

## Changing the system

1. Change a token in `app/globals.css`, in both `:root` and `.dark`. A new token also needs an entry in `tailwind.config.ts`.
2. Run `npm run test:e2e`; the theme suite checks contrast.
3. Update this document in the same change.
