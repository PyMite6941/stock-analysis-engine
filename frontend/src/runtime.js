// Where the app is running, and therefore where the API lives.
//
// On the web the page and the API share an origin, so every call can be a
// relative "/api/...". A packaged app has no such luxury: Capacitor serves from
// capacitor://localhost (iOS) or http://localhost (Android), and Electron from
// file://, so a relative path resolves to the bundle itself and every request
// 404s against nothing. Packaged builds therefore need an absolute base URL.
//
// One module owns that decision so no caller has to think about it, and so the
// base can be overridden at build time for someone self-hosting the backend
// somewhere else.

// Baked in at build time by Vite. Empty on the web build, which keeps calls
// relative and same-origin exactly as before.
const BUILD_API_BASE = (import.meta.env?.VITE_API_BASE || "").replace(/\/+$/, "");

// Where this project's own backend lives, used by packaged builds that were
// not given an explicit base.
const DEFAULT_REMOTE_API = "https://stock-analysis-engine.vercel.app";

export function platform() {
  if (typeof window === "undefined") return "ssr";
  // Capacitor injects this before the app boots.
  if (window.Capacitor?.getPlatform) {
    const p = window.Capacitor.getPlatform();
    if (p === "ios" || p === "android") return p;
  }
  // Set by Electron's preload script.
  if (window.__SAE_DESKTOP__) return "desktop";
  return "web";
}

export function isPackaged() {
  return platform() !== "web" && platform() !== "ssr";
}

/**
 * Base URL for API calls — "" on the web (relative, same-origin).
 *
 * Order matters: an explicit VITE_API_BASE wins everywhere, so a self-hoster
 * can point any build at their own backend without touching code.
 */
export function apiBase() {
  if (BUILD_API_BASE) return BUILD_API_BASE;
  return isPackaged() ? DEFAULT_REMOTE_API : "";
}

/** Turn an app-relative "/api/..." path into something fetchable here. */
export function apiUrl(path) {
  const base = apiBase();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * True when the browser can meaningfully run a service worker for this app.
 *
 * Packaged builds must NOT register one: Electron's file:// origin cannot, and
 * in Capacitor the native shell already bundles the assets, so a worker would
 * add a second stale copy of the app with nothing to gain.
 */
export function serviceWorkerUseful() {
  if (isPackaged()) return false;
  if (typeof window === "undefined") return false;
  return window.location.protocol === "https:"
    || window.location.hostname === "localhost";
}

/** A human label, used in the UI's About/diagnostics line. */
export function platformLabel() {
  return {
    ios: "iOS app", android: "Android app", desktop: "Desktop app",
    web: "Web", ssr: "Server",
  }[platform()] || "Web";
}

// Whether a backend answered at startup. null until App's health check runs.
//
// When the site is hosted as plain files (GitHub Pages, Netlify, any static
// host) there is no /api at all. Rather than show a login screen for a server
// that doesn't exist, the app switches to "direct mode" (see direct.js): the
// browser fetches prices itself using the visitor's own free API keys.
let backendUp = null;

export function setBackendAvailable(up) { backendUp = up; }

/** False only once we KNOW there is no backend; null (unknown) counts as up. */
export function backendAvailable() { return backendUp !== false; }
