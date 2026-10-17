import type { ReactNode } from "react";
import Link from "next/link";
import { Check, ChevronDown, Megaphone, MonitorPlay, Smartphone, Tablet, Tv, WifiOff, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_NAME, APP_TAGLINE } from "@/lib/config";
import { FlowPreview } from "./flow-preview";

const ACCESS_NOTE = `Open to everyone soon. For now, ${APP_NAME} is running with select communities.`;

const WITHOUT = [
  "Names yelled into a megaphone, twice, over the noise.",
  "Results scribbled on paper slips and walked back to the table.",
  "Players crowding the table to ask if they're up.",
  "Brackets redrawn by hand, one result at a time.",
];

const WITH = [
  "Each player gets a push on their phone, and the board says the call out loud.",
  "Judges tap every finish on a tablet. No paper.",
  "Each player sees their own place in the queue on their Pass.",
  "The bracket moves on by itself when the match ends.",
];

const STEPS = [
  { title: "The judge taps the pad", body: `Each finish is one tap on the ${APP_NAME} Pad: Spin, Over, Burst or Xtreme.` },
  {
    title: "The bracket moves on",
    body: `When a player reaches the target, the judge confirms and the winner moves on in the ${APP_NAME} bracket. Nobody types a score.`,
  },
  {
    title: "The next player gets the call",
    body: `"On deck", then "You're up", as a push from their ${APP_NAME} Pass. They're already walking to the stadium.`,
  },
  {
    title: "The board chimes",
    body: `The ${APP_NAME} Board on the venue TV chimes, says the call out loud, and shows who's on deck and in the hole.`,
  },
];

const SCREENS: { name: string; audience: string; body: string; icon: LucideIcon }[] = [
  { name: "Desk", audience: "For organizers", body: "Stadium cards, the queue, calls and recalls in one place.", icon: MonitorPlay },
  { name: "Board", audience: "For the floor", body: "A TV display that chimes, speaks every call and shows live scores.", icon: Tv },
  { name: "Pad", audience: "For judges", body: "Tablet scoring, finish by finish. Works offline, with no organizer sign-in on the device.", icon: Tablet },
  {
    name: "Pass",
    audience: "For players",
    body: "Their own queue position and scores, opened with a 4-digit passcode or the QR code on their slip.",
    icon: Smartphone,
  },
];

const FAQ: { question: string; answer: ReactNode }[] = [
  {
    question: `Who can use ${APP_NAME} right now?`,
    answer: `Select communities, while ${APP_NAME} is in early access. It opens to every organizer soon; until then, use Request Early Access.`,
  },
  {
    question: `Does ${APP_NAME} run the bracket too?`,
    answer: `Yes. You type in your players and pick a format: single or double elimination, round robin or Swiss, with an optional group stage before the final bracket. ${APP_NAME} makes the matches, moves winners on, and works out the standings. Nothing else to sign up for.`,
  },
  {
    question: "What do I need at the venue?",
    answer:
      "A laptop or tablet for the Desk, a tablet or phone at each stadium for its judge, and an internet connection. A TV or monitor with a browser for the board is optional. Players use their own phones.",
  },
  {
    question: "What if the venue Wi-Fi drops?",
    answer:
      "Judges keep scoring. Every tap is saved on the pad, and a match finished offline is saved once the connection is back. The Desk, the board and players' phones catch up when they reconnect.",
  },
  {
    question: "Do players need an app or an account?",
    answer:
      "No account, and nothing from an app store. A player opens their Pass by scanning the QR code on their slip, or by picking their name and typing their 4-digit passcode. For alerts they tap Enable notifications; on an iPhone they add the Pass to their Home Screen first.",
  },
  {
    question: `What player data does ${APP_NAME} keep?`,
    answer: (
      <>
        The player names you type in, the scores, and a push subscription for players who turn on notifications. Players give no email
        address or phone number, and each one sees only their own matches. The{" "}
        <Link href="/privacy" className="font-medium text-foreground underline underline-offset-4">
          Privacy Policy
        </Link>{" "}
        has the details.
      </>
    ),
  },
];

const section = "mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-14 sm:py-20";
const eyebrow = "text-sm font-bold uppercase tracking-widest text-primary-text";
const heading = "font-display text-3xl font-bold leading-tight sm:text-4xl";

/**
 * The main call to action. A signed-in organizer goes to their tournaments. Anyone else asks for
 * access off-site, wherever this deployment takes requests; with nowhere to lead, it is disabled.
 */
function CallToAction({ signedIn, href }: { signedIn: boolean; href: string | null }) {
  if (signedIn) {
    return (
      <div>
        <Button asChild size="lg">
          <Link href="/tournaments">Go to Dashboard</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div>
        {href ? (
          <Button asChild size="lg">
            <a href={href} target="_blank" rel="noopener noreferrer">
              Request Early Access
            </a>
          </Button>
        ) : (
          <Button size="lg" disabled>
            Request Early Access
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{ACCESS_NOTE}</p>
    </div>
  );
}

/**
 * The home page, open to everyone. `canSignIn` is false until the Supabase environment variables
 * are set; `signedIn` is an organizer who already has access.
 */
export function Landing({ canSignIn, signedIn, earlyAccessUrl }: { canSignIn: boolean; signedIn: boolean; earlyAccessUrl: string | null }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-4">
        <span className="font-display text-xl font-bold">{APP_NAME}</span>
        {canSignIn && (
          <Button asChild variant="ghost" size="sm">
            {signedIn ? <Link href="/tournaments">Go to Dashboard</Link> : <Link href="/auth/login">Organizer sign in</Link>}
          </Button>
        )}
      </header>

      <main className="flex flex-1 flex-col">
        <section className={`${section} lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-center lg:gap-12`}>
          <div className="flex flex-col gap-8">
            <div className="flex flex-col gap-5">
              {/* "Beyblade X" stays on one line, so the X is never left alone at the start of the next. */}
              <h1 className="text-balance font-display text-4xl font-bold leading-tight sm:text-6xl lg:text-5xl">
                Run your Beyblade&nbsp;X tournament on auto-pilot.
              </h1>
              <p className="text-lg text-muted-foreground sm:text-xl">
                {APP_NAME} runs the bracket, the stadium queues, the judge tablets and the player calls.
              </p>
            </div>
            <CallToAction signedIn={signedIn} href={earlyAccessUrl} />
            {!canSignIn && (
              <p role="alert" className="text-sm text-warning">
                Supabase environment variables are missing. See the README to set up .env.local.
              </p>
            )}
          </div>
          <FlowPreview />
        </section>

        <section aria-labelledby="two-ways" className={`${section} border-t`}>
          <div className="flex flex-col gap-2">
            <p className={eyebrow}>Tournament day, two ways</p>
            <h2 id="two-ways" className={heading}>
              Put down the megaphone.
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-4 rounded-2xl border bg-muted p-6">
              <h3 className="flex items-center gap-2 font-display text-xl font-bold text-muted-foreground">
                <Megaphone className="size-5" aria-hidden />
                Without {APP_NAME}
              </h3>
              <ul className="flex flex-col gap-3">
                {WITHOUT.map((line) => (
                  <li key={line} className="flex gap-3 text-muted-foreground">
                    <X className="mt-1 size-4 shrink-0" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-4 rounded-2xl border-2 border-primary-text bg-card p-6">
              <h3 className="font-display text-xl font-bold">With {APP_NAME}</h3>
              <ul className="flex flex-col gap-3">
                {WITH.map((line) => (
                  <li key={line} className="flex gap-3">
                    <Check className="mt-1 size-4 shrink-0 text-primary-text" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section aria-labelledby="one-tap" className={`${section} border-t`}>
          <div className="flex max-w-3xl flex-col gap-2">
            <p className={eyebrow}>How a match moves</p>
            <h2 id="one-tap" className={heading}>
              One tap, and everything moves.
            </h2>
          </div>
          <ol className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
            {STEPS.map(({ title, body }, index) => (
              <li key={title} className="flex flex-col gap-1.5 border-t-2 border-primary-text pt-4">
                <h3 className="flex items-baseline gap-2 font-display text-lg font-bold">
                  <span className="text-primary-text">{index + 1}</span>
                  {title}
                </h3>
                <p className="text-muted-foreground">{body}</p>
              </li>
            ))}
          </ol>
          <div className="flex gap-4 rounded-2xl border bg-card p-5 sm:items-center sm:p-6">
            <WifiOff className="mt-1 size-6 shrink-0 text-primary-text sm:mt-0" aria-hidden />
            <div className="flex flex-col gap-1">
              <h3 className="font-display text-lg font-bold">Offline-First by Design</h3>
              <p className="text-muted-foreground">
                Every tap is saved on the pad itself, so scoring carries on when the venue Wi-Fi drops. A match finished offline is saved by
                itself once the connection is back.
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="four-screens" className={`${section} border-t`}>
          <div className="flex flex-col gap-2">
            <p className={eyebrow}>The four screens</p>
            <h2 id="four-screens" className={heading}>
              One for everyone on the floor.
            </h2>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {SCREENS.map(({ name, audience, body, icon: Icon }) => (
              <li key={name} className="flex flex-col gap-2 rounded-2xl border bg-card p-5">
                <Icon className="size-6 text-primary-text" aria-hidden />
                <h3 className="font-display text-lg font-bold">
                  {APP_NAME} {name}
                </h3>
                <p className="text-sm font-semibold text-muted-foreground">{audience}</p>
                <p className="text-muted-foreground">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="faq" className={`${section} border-t`}>
          <div className="flex flex-col gap-2">
            <p className={eyebrow}>FAQ</p>
            <h2 id="faq" className={heading}>
              Questions organizers ask.
            </h2>
          </div>
          <div className="flex max-w-3xl flex-col">
            {FAQ.map(({ question, answer }) => (
              <details key={question} className="group border-b first:border-t">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-display text-lg font-bold [&::-webkit-details-marker]:hidden">
                  {question}
                  <ChevronDown className="size-5 shrink-0 text-primary-text transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <p className="pb-5 text-muted-foreground">{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="ready" className={`${section} border-t`}>
          <h2 id="ready" className={heading}>
            {APP_TAGLINE}
          </h2>
          <CallToAction signedIn={signedIn} href={earlyAccessUrl} />
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6 py-6 text-sm text-muted-foreground">
          <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-2">
            <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
              Terms of Service
            </Link>
            <Link href="/privacy" className="underline underline-offset-4 hover:text-foreground">
              Privacy Policy
            </Link>
          </nav>
          <p>
            {APP_NAME} is not affiliated with or endorsed by Takara Tomy. Beyblade X is a trademark of its owner.
          </p>
        </div>
      </footer>
    </div>
  );
}
