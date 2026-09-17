// Last-known price per symbol, so the app has something honest to show when
// the network or the API is unavailable.
//
// The service worker caches whole API responses keyed by URL, which is the
// wrong shape for quotes: the home page asks for indices + watchlist + holdings
// in one call, the analysis page asks for a different set, and a poll asks for
// a third. Every distinct combination is a separate cache entry and a cache
// MISS the first time you ask for it, so the URL cache almost never helps for
// the one thing people most want offline — what their portfolio is worth.
//
// Caching per SYMBOL fixes that: any response teaches us about every symbol in
// it, and any later request can be answered from the union. Same localStorage
// the holdings already live in, so no new storage story.

const LS_QUOTES = "sae:quote_cache";
const MAX_SYMBOLS = 120;
// Past this, a price is too old to be worth showing even with a warning.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_QUOTES) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function write(map) {
  try {
    // Evict oldest first so a long session can't grow storage without bound.
    const entries = Object.entries(map);
    if (entries.length > MAX_SYMBOLS) {
      entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
      map = Object.fromEntries(entries.slice(0, MAX_SYMBOLS));
    }
    localStorage.setItem(LS_QUOTES, JSON.stringify(map));
  } catch {
    /* private mode or quota — this is a nicety, never a requirement */
  }
  return map;
}

/** Record every quote in a successful response. */
export function rememberQuotes(quotes) {
  if (!Array.isArray(quotes) || !quotes.length) return;
  const map = read();
  const at = Date.now();
  for (const q of quotes) {
    if (!q?.symbol || q.not_found || !q.price) continue;
    map[q.symbol] = {
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      change: q.change,
      change_pct: q.change_pct,
      currency: q.currency,
      pe: q.pe ?? null,
      market_cap: q.market_cap ?? null,
      at,
    };
  }
  write(map);
}

/**
 * Best-effort quotes for `symbols` from the local cache.
 * Returns {quotes, cachedAt} — cachedAt is the OLDEST entry used, since that's
 * the honest age of the set as a whole.
 */
export function cachedQuotes(symbols) {
  const map = read();
  const now = Date.now();
  const out = [];
  let oldest = null;
  for (const raw of symbols || []) {
    const sym = String(raw).trim().toUpperCase();
    const hit = map[sym];
    if (!hit || !hit.price) continue;
    if (hit.at && now - hit.at > MAX_AGE_MS) continue;
    out.push({ ...hit, _stale: true });
    if (hit.at && (oldest === null || hit.at < oldest)) oldest = hit.at;
  }
  return { quotes: out, cachedAt: oldest ? new Date(oldest) : null };
}

export function clearQuoteCache() {
  try { localStorage.removeItem(LS_QUOTES); } catch { /* ignore */ }
}

export { MAX_SYMBOLS, MAX_AGE_MS };
