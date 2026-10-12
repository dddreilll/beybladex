// Service worker: player notifications (M4) and offline judge pads (M5). Dependency-free.
//
// Offline strategy is deliberately narrow: only judge pad pages and the app's static files are
// cached, always network-first, so online behaviour (including development hot reload) is
// unchanged and the cache only matters when the network is gone or stalled.

const CACHE = "judge-pad-v1";
// The organizer's pad, and a judge tablet's pad for the match at its stadium.
const PAD_PATH = /^(\/tournaments\/[0-9a-f-]{36}\/matches\/[0-9a-f-]{36}|\/t\/[a-f0-9]{16}\/judge\/[0-9a-f-]{36})$/i;
const STATIC_PREFIX = "/_next/static/";
const NAVIGATION_TIMEOUT_MS = 5000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

// ---------- Offline judge pad ----------

const offlinePage = () =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0E13;color:#EEF1F5;font-family:system-ui,sans-serif">
<main style="max-width:28rem;padding:1.5rem">
<h1 style="font-size:1.5rem">You're offline</h1>
<p>This judge pad hasn't been opened on this device before, so it can't be shown without a connection.</p>
<p>Battles you already recorded are saved on this device and will sync when the connection is back.</p>
<p><a href="" style="color:#C8F560">Try again</a></p>
</main></body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

async function fromCache(key) {
  return (await caches.open(CACHE)).match(key, { ignoreVary: true });
}

async function store(key, response) {
  // Never cache a redirect to the login page (or any error) as if it were the pad.
  if (response.ok && !response.redirected) await (await caches.open(CACHE)).put(key, response.clone());
}

async function padNavigation(request) {
  const key = new URL(request.url).pathname;
  const network = fetch(request).then(async (response) => {
    await store(key, response);
    return response;
  });
  // On a stalled connection, fall back to the cached pad instead of making the judge wait.
  const timeout = new Promise((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS, null));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    return (await fromCache(key)) || (await network);
  } catch {
    return (await fromCache(key)) || offlinePage();
  }
}

async function staticAsset(request) {
  try {
    const response = await fetch(request);
    await store(request.url, response);
    return response;
  } catch (error) {
    const cached = await fromCache(request.url);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && PAD_PATH.test(url.pathname)) event.respondWith(padNavigation(request));
  else if (url.pathname.startsWith(STATIC_PREFIX)) event.respondWith(staticAsset(request));
});

/** Pre-loads pads (and the scripts and styles they reference) so they open offline later. */
async function warm(urls) {
  const cache = await caches.open(CACHE);
  for (const raw of urls.slice(0, 12)) {
    const url = new URL(raw, self.location.origin);
    if (url.origin !== self.location.origin || !PAD_PATH.test(url.pathname)) continue;
    try {
      const response = await fetch(url.pathname, { credentials: "same-origin" });
      if (!response.ok || response.redirected) continue;
      const html = await response.clone().text();
      await cache.put(url.pathname, response);
      const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\)<>]+/g) || [])].slice(0, 120);
      await Promise.all(
        assets.map(async (asset) => {
          if (await cache.match(new URL(asset, self.location.origin).href)) return;
          try {
            const res = await fetch(asset);
            if (res.ok) await cache.put(new URL(asset, self.location.origin).href, res);
          } catch {}
        }),
      );
    } catch {}
  }
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "cache-pages" && Array.isArray(data.urls)) event.waitUntil(warm(data.urls));
  // Cached pads contain the signed-in organizer's data: drop them on sign-out.
  if (data.type === "clear-caches") event.waitUntil(caches.delete(CACHE));
});

// ---------- Player notifications ----------

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || "Your match", {
      body: data.body || "",
      tag: data.tag || "match",
      renotify: true,
      icon: "/icons/192",
      badge: "/icons/192",
      vibrate: [300, 150, 300],
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only ever open pages on our own origin.
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url === url);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
