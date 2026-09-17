/* Service worker: makes the app installable and usable without a connection.
 *
 * The caching strategy is deliberately different for the two kinds of request,
 * because this is a finance app and stale prices are actively harmful:
 *
 *   App shell (HTML/JS/CSS/icons)  cache-first, refreshed in the background.
 *     These are content-hashed by Vite, so a cached asset is never wrong — it
 *     is either current or replaced under a new filename.
 *
 *   API responses                  network-first, cache only as a fallback.
 *     Fresh data always wins. A cached quote is served ONLY when the network
 *     fails, and it is tagged with the time it was stored so the UI can say
 *     plainly that the number is old. Never show a stale price as if it were
 *     live.
 *
 * Nothing here syncs, uploads or phones home. The cache is per-device, same as
 * the localStorage the holdings already live in.
 */

const VERSION = "v1";
const SHELL_CACHE = `sae-shell-${VERSION}`;
const API_CACHE = `sae-api-${VERSION}`;

// Minimum needed to boot offline. Vite's hashed bundles are added on the fly by
// the fetch handler, since their names change every build.
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

// Endpoints worth keeping a copy of. Anything the user's own portfolio view
// depends on — so holdings still render with last-known prices offline.
const CACHEABLE_API = [
  "/api/quotes",
  "/api/health",
  "/api/candles",
  "/api/history",
  "/api/fundamentals",
  "/api/holdings",
];

const MAX_API_ENTRIES = 60;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll is atomic: one 404 would abort the whole install, so tolerate
      // individual misses rather than shipping a worker that can't activate.
      .then((cache) => Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("sae-") &&
                           k !== SHELL_CACHE && k !== API_CACHE)
            .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Keep the API cache from growing without bound (oldest entries evicted). */
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}

/** Serve a cached copy, tagged so the UI can say the data is old. */
async function offlineCopy(cache, request) {
  const cached = await cache.match(request);
  if (!cached) return null;
  const headers = new Headers(cached.headers);
  headers.set("x-sae-offline", "1");
  return new Response(await cached.blob(), {
    status: 200, statusText: "OK (offline cache)", headers,
  });
}

/** Network-first with a timestamped cache fallback.
 *
 * "Network failed" has to include a 5xx, not just a thrown fetch. A dead
 * backend behind a live proxy — or a Vercel function that timed out — answers
 * with a 502/504 and an empty body, which `fetch` treats as success. Without
 * this the user gets a broken response while a perfectly good cached copy sits
 * unused.
 *
 * 4xx deliberately passes through: "Stock/ETF not found" is a real answer about
 * a real request, and replacing it with stale cache would be a lie.
 */
async function apiStrategy(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const fresh = await fetch(request);

    if (fresh.status >= 500) {
      const stale = await offlineCopy(cache, request);
      if (stale) return stale;
      return fresh;                       // nothing cached — pass the error on
    }

    if (fresh.ok && CACHEABLE_API.some((p) => new URL(request.url).pathname.startsWith(p))) {
      // Stamp the stored copy so the page can report how old it is. Cloning is
      // required — a Response body can only be read once.
      const body = await fresh.clone().blob();
      const headers = new Headers(fresh.headers);
      headers.set("x-sae-cached-at", new Date().toISOString());
      await cache.put(request, new Response(body, {
        status: fresh.status, statusText: fresh.statusText, headers,
      }));
      trimCache(API_CACHE, MAX_API_ENTRIES);
    }
    return fresh;
  } catch (err) {
    const stale = await offlineCopy(cache, request);
    if (stale) return stale;
    // Nothing cached: return a JSON error the app's fetch wrapper understands
    // rather than letting it throw an opaque TypeError.
    return new Response(
      JSON.stringify({
        detail: "You're offline and this hasn't been loaded before.",
        error: "offline",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
}

/** Cache-first for hashed static assets, refreshed in the background. */
async function shellStrategy(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Revalidate quietly so the next load gets any update.
    fetch(request)
      .then((res) => {
        if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(request, res));
      })
      .catch(() => { /* offline — the cached copy is what we wanted anyway */ });
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res.ok) {
      const copy = res.clone();
      caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
    }
    return res;
  } catch (err) {
    // SPA navigation offline: serve the cached shell so the app boots and can
    // render whatever is in localStorage.
    if (request.mode === "navigate") {
      const shell = await caches.match("/index.html") || await caches.match("/");
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;          // never cache writes

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // leave CDNs alone

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(apiStrategy(request));
  } else {
    event.respondWith(shellStrategy(request));
  }
});

// Lets the page trigger an immediate update instead of waiting for a reload.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
