// "Direct mode": market data straight from the browser, with no backend.
//
// Why this needs keys at all: the backend gets prices from Yahoo, but Yahoo
// doesn't send the CORS header (Access-Control-Allow-Origin) that browsers
// need before a page may read another site's reply. Finnhub and Twelve Data
// DO send it, so the browser can talk to them directly — but they want an API
// key.
//
// Why the keys belong to the visitor: anything shipped in the JS bundle is
// public (press F12 and it's there), so a key baked into the site would be
// shared with, and used up by, the whole internet. Instead each person pastes
// their OWN free key. It is stored only in their browser's localStorage and
// only ever sent to the provider it belongs to. No sign-in, no server.
//
// Providers:
//   Finnhub      quotes, company names, search   (free: 60 calls/minute)
//   Twelve Data  price history for charts        (free: 8 calls/minute, 800/day)

import { computeAll } from "./indicators.js";
import { analyzeHistory, portfolioSummary } from "./metrics.js";

const LS_KEYS = "sae:directKeys";
const LS_NAMES = "sae:directNames";

const FINNHUB = "https://finnhub.io/api/v1";
const TWELVE = "https://api.twelvedata.com";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export function loadKeys() {
  try {
    const k = JSON.parse(localStorage.getItem(LS_KEYS) || "{}");
    return { finnhub: k.finnhub || "", twelvedata: k.twelvedata || "" };
  } catch {
    return { finnhub: "", twelvedata: "" };
  }
}

// Keys are short letters-and-digits strings. Refusing anything else stops a
// pasted sentence (or something sneakier) ending up inside a request URL.
export function cleanKey(k) {
  const s = String(k || "").trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(s) ? s : "";
}

export function saveKeys({ finnhub, twelvedata }) {
  const keys = { finnhub: cleanKey(finnhub), twelvedata: cleanKey(twelvedata) };
  try { localStorage.setItem(LS_KEYS, JSON.stringify(keys)); } catch { /* private mode */ }
  return keys;
}

export function forgetKeys() {
  try { localStorage.removeItem(LS_KEYS); } catch { /* ignore */ }
}

export function hasKeys() {
  const k = loadKeys();
  return Boolean(k.finnhub || k.twelvedata);
}

class DirectError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DirectError";
    this.code = code;
  }
}

function need(key, provider) {
  const k = loadKeys()[key];
  if (!k) {
    throw new DirectError(
      `Add a free ${provider} key (Home → 🔑 Data keys) to load this without a server.`,
      "missing_key");
  }
  return k;
}

// ---------------------------------------------------------------------------
// Symbols: the app speaks Yahoo-style tickers; the providers don't all agree.
// ---------------------------------------------------------------------------

// Free keys can't fetch index values, so indices are shown through the ETF
// that tracks them. The name says so: the PRICE is the ETF's (SPY is about a
// tenth of the S&P 500), but the day's % move is almost identical.
export const INDEX_PROXIES = {
  "^GSPC": "SPY", "^IXIC": "QQQ", "^DJI": "DIA", "^RUT": "IWM",
};

export function isCrypto(symbol) {
  return /^[A-Z0-9]{2,10}-USD$/.test(symbol);
}

/** "BTC-USD" -> "BTC/USD", "BRK-B" -> "BRK.B" for Twelve Data. */
export function toTwelveSymbol(symbol) {
  if (isCrypto(symbol)) return symbol.replace("-", "/");
  return symbol.replace("-", ".");
}

/** "BRK-B" -> "BRK.B" for Finnhub. */
export function toFinnhubSymbol(symbol) {
  return symbol.replace("-", ".");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function getJson(url, signal) {
  let r;
  try {
    r = await fetch(url, { signal, referrerPolicy: "no-referrer" });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new DirectError("Couldn't reach the data provider. Check your connection.", "network");
  }
  if (r.status === 401 || r.status === 403) {
    throw new DirectError("The data provider rejected your API key. Check it under 🔑 Data keys.", "bad_key");
  }
  if (r.status === 429) {
    throw new DirectError("Free-tier limit reached. Wait a minute and try again.", "rate_limited");
  }
  if (!r.ok) throw new DirectError(`Data provider error (${r.status}).`, "provider");
  return r.json();
}

// Run `fn` over `items` with at most `limit` in flight, so a 30-symbol page
// doesn't fire 30 requests in the same instant and trip the rate limit.
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Company names never change, so each one is looked up once and remembered.
function loadNames() {
  try { return JSON.parse(localStorage.getItem(LS_NAMES) || "{}"); } catch { return {}; }
}
function rememberName(symbol, name) {
  const names = loadNames();
  names[symbol] = name;
  try { localStorage.setItem(LS_NAMES, JSON.stringify(names)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** Turn Finnhub's terse reply into the same shape /api/quotes returns. */
export function finnhubToQuote(symbol, q, name, marketCap = null) {
  // Finnhub answers an unknown ticker with all zeros rather than an error.
  if (!q || !q.c) {
    return { symbol, name: symbol, price: null, change: null, change_pct: null,
             currency: "USD", pe: null, market_cap: null, not_found: true };
  }
  return {
    symbol,
    name: name || symbol,
    price: q.c,
    change: q.d ?? q.c - q.pc,
    change_pct: q.dp ?? (q.pc ? ((q.c - q.pc) / q.pc) * 100 : 0),
    currency: "USD",
    pe: null,
    market_cap: marketCap,
    not_found: false,
    // Extra fields day traders care about; the rest of the app ignores them.
    open: q.o, high: q.h, low: q.l, prev_close: q.pc,
  };
}

async function finnhubQuote(symbol, key) {
  const fsym = toFinnhubSymbol(symbol);
  const tok = encodeURIComponent(key);
  const q = await getJson(`${FINNHUB}/quote?symbol=${encodeURIComponent(fsym)}&token=${tok}`);

  let name = loadNames()[symbol];
  let cap = null;
  if (!name && q && q.c) {
    try {
      const p = await getJson(`${FINNHUB}/stock/profile2?symbol=${encodeURIComponent(fsym)}&token=${tok}`);
      if (p && p.name) {
        name = p.name;
        rememberName(symbol, name);
        // Finnhub gives market cap in millions.
        cap = p.marketCapitalization ? p.marketCapitalization * 1e6 : null;
      }
    } catch { /* a missing name isn't worth failing the quote over */ }
  }
  return finnhubToQuote(symbol, q, name, cap);
}

async function twelveQuote(symbol, key) {
  const q = await getJson(`${TWELVE}/quote?symbol=${encodeURIComponent(toTwelveSymbol(symbol))}`
    + `&apikey=${encodeURIComponent(key)}`);
  if (!q || q.status === "error" || q.close == null) {
    return finnhubToQuote(symbol, null);
  }
  const price = Number(q.close);
  const prev = Number(q.previous_close);
  return finnhubToQuote(symbol, {
    c: price, pc: prev, d: price - prev, dp: Number(q.percent_change),
    o: Number(q.open), h: Number(q.high), l: Number(q.low),
  }, q.name);
}

export async function quotes(symbols) {
  const keys = loadKeys();
  if (!keys.finnhub && !keys.twelvedata) need("finnhub", "Finnhub");

  const one = async (symbol) => {
    const proxy = INDEX_PROXIES[symbol];
    try {
      if (proxy) {
        if (!keys.finnhub) return finnhubToQuote(symbol, null);
        const q = await finnhubQuote(proxy, keys.finnhub);
        return { ...q, symbol, name: `via ${proxy} ETF (price is the ETF's)` };
      }
      if (symbol.startsWith("^")) return finnhubToQuote(symbol, null);
      // Finnhub's free quote endpoint is US stocks and ETFs; crypto goes to
      // Twelve Data, which takes "BTC/USD".
      if (isCrypto(symbol) || !keys.finnhub) {
        if (!keys.twelvedata) return finnhubToQuote(symbol, null);
        return await twelveQuote(symbol, keys.twelvedata);
      }
      return await finnhubQuote(symbol, keys.finnhub);
    } catch (e) {
      // A bad key or a rate limit affects every symbol, so let it surface.
      if (e.code === "bad_key" || e.code === "rate_limited") throw e;
      return finnhubToQuote(symbol, null);
    }
  };

  return { quotes: await mapLimited(symbols, 6, one), source: "direct" };
}

// ---------------------------------------------------------------------------
// Candles (chart history)
// ---------------------------------------------------------------------------

const TWELVE_INTERVAL = {
  "1m": "1min", "2m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
  "1h": "1h", "3h": "4h", "1d": "1day", "1wk": "1week",
};
// Trading days in each period.
const PERIOD_DAYS = {
  "1d": 1, "5d": 5, "1mo": 21, "3mo": 63, "6mo": 126, "1y": 252,
  "2y": 504, "5y": 1260, "10y": 2520, max: 5000,
};
// Bars in one 6.5-hour US trading day, per interval.
const BARS_PER_DAY = {
  "1min": 390, "5min": 78, "15min": 26, "30min": 13, "1h": 7, "4h": 2,
  "1day": 1, "1week": 0.2,
};

/** How many bars to ask for so the chart covers `period` at `interval`. */
export function barsFor(period, interval) {
  const tdInterval = TWELVE_INTERVAL[interval] || "1day";
  const days = PERIOD_DAYS[period] ?? 126;
  // Twelve Data caps a single request at 5000 bars.
  return { interval: tdInterval,
           outputsize: Math.min(5000, Math.max(2, Math.ceil(days * BARS_PER_DAY[tdInterval]))) };
}

/** Twelve Data's newest-first string rows -> the /api/candles shape. */
export function twelveToCandles(symbol, res) {
  if (!res || res.status === "error" || !Array.isArray(res.values)) {
    throw new DirectError(res?.message || `No price history for ${symbol}.`, "not_found");
  }
  const rows = [...res.values].reverse();
  const out = { symbol, dates: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const r of rows) {
    // Intraday rows are "YYYY-MM-DD HH:MM:SS" in UTC (we ask for UTC), which is
    // exactly the format the chart already understands.
    out.dates.push(r.datetime.length > 10 ? r.datetime.slice(0, 16) : r.datetime);
    out.open.push(Number(r.open));
    out.high.push(Number(r.high));
    out.low.push(Number(r.low));
    out.close.push(Number(r.close));
    out.volume.push(r.volume != null ? Number(r.volume) : 0);
  }
  out.indicators = out.close.length ? computeAll(out.close) : {};
  return out;
}

export async function candles(symbol, period = "6mo", interval = "1d") {
  const key = need("twelvedata", "Twelve Data");
  const { interval: tdInterval, outputsize } = barsFor(period, interval);
  const q = new URLSearchParams({
    symbol: toTwelveSymbol(INDEX_PROXIES[symbol] || symbol),
    interval: tdInterval, outputsize: String(outputsize), timezone: "UTC", apikey: key,
  });
  return twelveToCandles(symbol, await getJson(`${TWELVE}/time_series?${q}`));
}

// ---------------------------------------------------------------------------
// Search ("nvidia" -> NVDA)
// ---------------------------------------------------------------------------

export async function search(q, limit = 8, signal) {
  const key = loadKeys().finnhub;
  if (!key) return { query: q, results: [] };
  const res = await getJson(`${FINNHUB}/search?q=${encodeURIComponent(q)}`
    + `&token=${encodeURIComponent(key)}`, signal);
  const results = (res.result || [])
    // Foreign listings ("AAPL.MX") only confuse; keep plain US tickers.
    .filter((r) => r.symbol && !r.symbol.includes("."))
    .slice(0, limit)
    .map((r) => ({
      symbol: r.symbol.toUpperCase(),
      name: r.description || r.symbol,
      exchange: null,
      quote_type: r.type || null,
      asset_class: r.type === "ETP" ? "etf" : "equity",
      label: r.type === "ETP" ? "ETF" : "Stock",
    }));
  return { query: q, results };
}

// ---------------------------------------------------------------------------
// Analyze: the analysis page's main load, same shape as POST /api/analyze
// ---------------------------------------------------------------------------

export async function analyze(symbols, period = "6mo") {
  const { quotes: all } = await quotes(symbols);
  const good = all.filter((q) => !q.not_found);
  const unknown = all.filter((q) => q.not_found).map((q) => q.symbol);
  if (!good.length) {
    throw new DirectError(`Stock/ETF not found: ${unknown.join(", ")}`, "symbol_not_found");
  }

  // History needs Twelve Data. Without that key the page still works — the
  // quotes show — but the history-based stats read "not enough data".
  const hasHistory = Boolean(loadKeys().twelvedata);
  // Two at a time: the free tier allows only 8 requests a minute.
  const hists = await mapLimited(good, 2, async (q) => {
    if (!hasHistory) return { symbol: q.symbol, dates: [], closes: [] };
    try {
      const c = await candles(q.symbol, period, "1d");
      return { symbol: q.symbol, dates: c.dates, closes: c.close };
    } catch (e) {
      if (e.code === "bad_key") throw e;
      return { symbol: q.symbol, dates: [], closes: [] };
    }
  });

  const analyses = hists.map((h) => analyzeHistory(h.symbol, h.closes));
  return {
    quotes: good,
    analyses,
    histories: Object.fromEntries(hists.map((h) => [h.symbol, h])),
    summary: portfolioSummary(good, analyses),
    not_found: unknown,
    source: "direct",
  };
}

/** Pre-fill known company names so quoting a list doesn't cost a lookup each. */
export function seedNames(map) {
  const names = loadNames();
  let changed = false;
  for (const [s, n] of Object.entries(map)) {
    if (!names[s]) { names[s] = n; changed = true; }
  }
  if (changed) {
    try { localStorage.setItem(LS_NAMES, JSON.stringify(names)); } catch { /* ignore */ }
  }
}
