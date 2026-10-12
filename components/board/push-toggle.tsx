"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Check } from "lucide-react";

type State =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "working" }
  | { kind: "denied" }
  | { kind: "needs_install" } // iPhone/iPad in the browser: push only works from the home screen
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

const SW_URL = "/sw.js";

function urlBase64ToUint8Array(value: string) {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration(SW_URL);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Binds this browser's subscription to the player signed in on it (the server knows who that is). */
async function link(slug: string, subscription: PushSubscription) {
  const res = await fetch(`/api/public/${slug}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't save the subscription.");
}

/** Stops this browser's notifications for the tournament. */
async function unlinkPush(slug: string) {
  if (!pushSupported()) return;
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  await fetch(`/api/public/${slug}/push`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {});
}

export function PushToggle({ slug, vapidPublicKey }: { slug: string; vapidPublicKey: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const detect = async (): Promise<State> => {
      if (!pushSupported()) return isIos() && !isStandalone() ? { kind: "needs_install" } : { kind: "unsupported" };
      if (Notification.permission === "denied") return { kind: "denied" };
      const subscription = await currentSubscription();
      if (subscription && Notification.permission === "granted") {
        // Already subscribed on this phone: make sure it's bound to the player signed in now.
        await link(slug, subscription);
        return { kind: "on" };
      }
      return { kind: "off" };
    };
    detect()
      .catch((): State => ({ kind: "off" }))
      .then((next) => !cancelled && setState(next));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const enable = async () => {
    setState({ kind: "working" });
    try {
      const registration = await navigator.serviceWorker.register(SW_URL);
      await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? { kind: "denied" } : { kind: "off" });
        return;
      }
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
      await link(slug, subscription);
      setState({ kind: "on" });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't turn on notifications." });
    }
  };

  const disable = async () => {
    setState({ kind: "working" });
    await unlinkPush(slug);
    await (await currentSubscription().catch(() => null))?.unsubscribe().catch(() => {});
    setState({ kind: "off" });
  };

  if (state.kind === "loading") return null;

  if (state.kind === "on") {
    return (
      <section role="status" className="flex items-center gap-3 rounded-2xl bg-success-muted p-4 text-success">
        <Check className="size-5 shrink-0" aria-hidden />
        <div className="flex flex-1 flex-col">
          <span className="font-bold">Notifications on</span>
          <span className="text-sm">We&apos;ll ping this phone when you&apos;re on deck and when you&apos;re called.</span>
        </div>
        <button type="button" onClick={() => void disable()} className="min-h-11 rounded-lg border border-success/40 px-3 text-sm font-semibold">
          Turn off
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Notifications" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div>
        <h2 className="text-lg font-bold">Get pinged when you&apos;re called</h2>
        <p className="text-sm text-muted-foreground">
          We&apos;ll notify this phone with your stadium, even if this page is closed.
        </p>
      </div>

      {state.kind === "needs_install" && (
        <ol className="flex flex-col gap-2 text-sm">
          {["Tap the Share button in Safari", "Choose “Add to Home Screen”", "Open the app from your home screen, sign in with your passcode, then enable notifications"].map(
            (step, i) => (
              <li key={step} className="flex items-center gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold">{i + 1}</span>
                {step}
              </li>
            ),
          )}
        </ol>
      )}
      {state.kind === "unsupported" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <BellOff className="size-4 shrink-0" aria-hidden />
          This browser can&apos;t show notifications. Keep this page open instead: it updates by itself.
        </p>
      )}
      {state.kind === "denied" && (
        <p className="flex items-center gap-2 text-sm text-warning">
          <BellOff className="size-4 shrink-0" aria-hidden />
          Notifications are blocked for this site. Allow them in your browser&apos;s site settings, then reload.
        </p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      {(state.kind === "off" || state.kind === "working" || state.kind === "error") && (
        <button
          type="button"
          disabled={state.kind === "working"}
          onClick={() => void enable()}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-foreground font-bold text-background disabled:opacity-60"
        >
          <Bell className="size-5" aria-hidden />
          {state.kind === "working" ? "Turning on…" : "Enable notifications"}
        </button>
      )}
    </section>
  );
}
