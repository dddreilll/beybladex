import type { ReactNode } from "react";
import Link from "next/link";
import { APP_NAME, contactEmail, operatorName } from "@/lib/config";

/** When the Terms of Service and the Privacy Policy last changed. Update it with either text. */
export const LEGAL_UPDATED = "12 October 2026";

/**
 * The operator as the two documents name them, and how to reach them, from this deployment's
 * settings. `named` is false when no name is set and `operator` is only a description.
 */
export function legalParties() {
  const name = operatorName();
  return { operator: name ?? "the operator of this site", named: name !== null, email: contactEmail() };
}

/** "Write to x@y." when this deployment has a contact address; otherwise how to reach the operator without one. */
export function ContactLine({ email }: { email: string | null }) {
  return email ? (
    <>
      Write to{" "}
      <a href={`mailto:${email}`} className="font-medium text-foreground underline underline-offset-4">
        {email}
      </a>
      .
    </>
  ) : (
    <>Ask the organizer of your tournament, or whoever gave you access to this site.</>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-xl font-bold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-5">{children}</ul>;
}

/** The shared frame of /terms and /privacy: readable width, the app name as the way home, and each other's link. */
export function LegalPage({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-4">
        <Link href="/" className="font-display text-xl font-bold">
          {APP_NAME}
        </Link>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10 leading-relaxed text-muted-foreground">
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-4xl font-bold leading-tight text-foreground">{title}</h1>
          <p className="text-sm">Last updated {LEGAL_UPDATED}</p>
          <p>{intro}</p>
        </div>
        {children}
      </main>
      <footer className="border-t">
        <nav aria-label="Legal" className="mx-auto flex w-full max-w-3xl flex-wrap gap-x-6 gap-y-2 px-6 py-6 text-sm text-muted-foreground">
          <Link href="/terms" className="underline underline-offset-4">
            Terms of Service
          </Link>
          <Link href="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>
          <Link href="/" className="underline underline-offset-4">
            Back to {APP_NAME}
          </Link>
        </nav>
      </footer>
    </div>
  );
}
