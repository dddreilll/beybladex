"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Laptop, Link2, Menu, Moon, ScrollText, Sun, Trophy, X, type LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { BudgetMeter } from "@/components/budget-meter";
import { LogoutButton } from "@/components/logout-button";
import { APP_NAME } from "@/lib/config";
import { cn } from "@/lib/utils";

const ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/tournaments", label: "Tournaments", icon: Trophy },
  { href: "/rules", label: "Rules", icon: ScrollText },
  { href: "/settings/challonge", label: "Challonge connection", icon: Link2 },
];

const THEMES: { value: string; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
];

/**
 * The app's navigation: a menu button that opens a panel from the left, over the page.
 * It is closed on every page load and closes again when a page is picked, on Escape,
 * or when the dimmed area is clicked.
 */
export function SideNav({ email, requestsUsed }: { email: string | null; /** null until a Challonge app is connected. */ requestsUsed: number | null }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = button.current;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [])];
    focusable()[0]?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      // Keep keyboard focus inside the panel while it covers the page.
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls="side-nav"
        onClick={() => setOpen(true)}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md border hover:bg-secondary"
      >
        <Menu className="size-5" aria-hidden />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex">
          <div
            id="side-nav"
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="relative z-10 flex h-full w-[min(18rem,85vw)] flex-col gap-6 border-r bg-card p-5 text-card-foreground shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-display text-lg font-bold">{APP_NAME}</span>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="inline-flex size-11 items-center justify-center rounded-md hover:bg-secondary"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>

            <nav aria-label="Main" className="flex flex-col gap-1">
              {ITEMS.map(({ href, label, icon: Icon }) => {
                const current = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={current ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-lg px-3 font-semibold hover:bg-secondary",
                      current && "bg-secondary text-foreground",
                      !current && "text-muted-foreground",
                    )}
                  >
                    <Icon className="size-5 shrink-0" aria-hidden />
                    {label}
                  </Link>
                );
              })}
            </nav>

            <div className="mt-auto flex flex-col gap-4">
              {requestsUsed !== null && <BudgetMeter used={requestsUsed} className="min-w-0 border-b pb-4" />}
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">Theme</legend>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1">
                  {THEMES.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={theme === value}
                      onClick={() => setTheme(value)}
                      className={cn(
                        "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md text-sm font-semibold",
                        theme === value ? "bg-background text-foreground shadow" : "text-muted-foreground",
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="flex items-center justify-between gap-3 border-t pt-4">
                <span className="min-w-0 truncate text-sm text-muted-foreground">{email}</span>
                <LogoutButton />
              </div>
            </div>
          </div>
          <div aria-hidden className="flex-1 bg-black/60" onClick={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
