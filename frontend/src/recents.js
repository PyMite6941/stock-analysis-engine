// Recently searched tickers.
//
// Storage hygiene matters here: this app sets NO cookies at all (cookies would
// be sent on every single request, which is pure waste for data the server never
// reads). Everything lives in localStorage, which stays on the device.
//
// The list is capped and stores only the uppercase ticker plus a timestamp —
// roughly 25 bytes per entry, so the whole history is well under 1 KB even at
// the cap. Nothing here grows unbounded.

const LS_RECENTS = "sae:recents";
const MAX_RECENTS = 12;

export function loadRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_RECENTS) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && typeof r.symbol === "string")
      .slice(0, MAX_RECENTS)
      .map((r) => ({ symbol: r.symbol.toUpperCase(), at: Number(r.at) || 0 }));
  } catch {
    return [];
  }
}

function persist(list) {
  try {
    localStorage.setItem(LS_RECENTS, JSON.stringify(list));
  } catch {
    /* private mode or quota — the in-memory list still works this session */
  }
  return list;
}

// Records one or more tickers as searched. Newest first, de-duplicated, capped.
export function recordSearch(input) {
  const symbols = (Array.isArray(input) ? input : String(input).split(","))
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length) return loadRecents();

  const now = Date.now();
  const existing = loadRecents();
  // Re-searching an existing ticker moves it to the front rather than duplicating.
  const merged = [
    ...symbols.map((symbol) => ({ symbol, at: now })),
    ...existing.filter((r) => !symbols.includes(r.symbol)),
  ];
  return persist(merged.slice(0, MAX_RECENTS));
}

export function clearRecents() {
  return persist([]);
}

export function removeRecent(symbol) {
  return persist(loadRecents().filter((r) => r.symbol !== symbol.toUpperCase()));
}

// "2h ago" / "3d ago" — enough context without storing a formatted string.
export function ago(ts) {
  if (!ts) return "";
  const secs = Math.max(0, (Date.now() - ts) / 1000);
  if (secs < 90) return "just now";
  const mins = secs / 60;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export { MAX_RECENTS };
