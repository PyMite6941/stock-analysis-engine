// Install + offline plumbing for the phone experience.
//
// The app already keeps holdings, alerts and closed trades in localStorage, so
// once the shell is cached there is genuinely something to look at with no
// connection: your positions, what you paid, and the last prices we saw. The
// one rule this file exists to enforce is that a stale price must never be
// presented as a live one.

const SW_URL = "/sw.js";
const LS_DISMISSED = "sae:install_dismissed";

let deferredPrompt = null;
const listeners = new Set();

function emit(state) {
  listeners.forEach((fn) => {
    try { fn(state); } catch { /* a bad listener shouldn't break the rest */ }
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --- install -------------------------------------------------------------
export function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    // iOS Safari predates the standard and uses a non-standard property.
    window.navigator.standalone === true
  );
}

export function canInstall() {
  return deferredPrompt !== null;
}

export function installDismissed() {
  try { return localStorage.getItem(LS_DISMISSED) === "1"; } catch { return false; }
}

export function dismissInstall() {
  try { localStorage.setItem(LS_DISMISSED, "1"); } catch { /* private mode */ }
  emit({ type: "install-dismissed" });
}

/** Show the browser's own install dialog. Must be called from a user gesture. */
export async function promptInstall() {
  if (!deferredPrompt) return "unavailable";
  const prompt = deferredPrompt;
  deferredPrompt = null;            // a prompt can only be used once
  emit({ type: "install-unavailable" });
  try {
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === "dismissed") dismissInstall();
    return outcome;
  } catch {
    return "failed";
  }
}

// iOS has no beforeinstallprompt at all — Safari requires Share > Add to Home
// Screen, so the UI has to tell people that instead of offering a button.
export function isIos() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
    // iPadOS 13+ reports as a Mac; the touch points give it away.
    (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
}

// --- offline -------------------------------------------------------------
export function isOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// Serving-stale-data state, which is NOT the same as being offline.
// navigator.onLine only reports whether the device has a network — when the
// API itself is down or timing out, the connection is fine and the service
// worker quietly serves a cached copy. Without this the page would show old
// prices as if they were live, which is the one thing it must never do.
let staleSince = null;

export function staleData() {
  return staleSince;
}

export function markStale(cachedAt) {
  const when = cachedAt ? new Date(cachedAt) : new Date();
  if (Number.isNaN(when.getTime())) return;
  staleSince = when;
  emit({ type: "stale", at: when });
}

export function clearStale() {
  if (!staleSince) return;
  staleSince = null;
  emit({ type: "fresh" });
}

// --- registration --------------------------------------------------------
export function registerServiceWorker() {
  if (typeof window === "undefined") return;

  window.addEventListener("beforeinstallprompt", (e) => {
    // Chrome shows its own mini-infobar otherwise; we want our own button so
    // it can sit next to the theme toggle rather than covering content.
    e.preventDefault();
    deferredPrompt = e;
    emit({ type: "install-available" });
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    emit({ type: "installed" });
  });

  window.addEventListener("online", () => emit({ type: "online" }));
  window.addEventListener("offline", () => emit({ type: "offline" }));

  if (!("serviceWorker" in navigator)) return;
  // Dev builds are served by Vite with no /sw.js; registering there would 404
  // and pollute the console on every reload.
  if (!import.meta.env.PROD) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register(SW_URL).then((reg) => {
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener("statechange", () => {
          if (next.state === "installed" && navigator.serviceWorker.controller) {
            emit({ type: "update-available", apply: () => {
              next.postMessage("skip-waiting");
              window.location.reload();
            } });
          }
        });
      });
    }).catch(() => { /* unsupported or blocked — the app still works online */ });
  });
}
