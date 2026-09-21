// Thin client for the FastAPI backend. All calls go through Vite's /api proxy.

import { clearStale, markStale } from "./pwa.js";
import { cachedQuotes, rememberQuotes } from "./quoteCache.js";

const AUTH_KEY = "sae:api_key";

function headers(extra = {}) {
  const key = sessionStorage.getItem(AUTH_KEY);
  if (key) extra["Authorization"] = `Bearer ${key}`;
  return { ...extra };
}

// The backend distinguishes a typo'd ticker (404 + error:"symbol_not_found")
// from a real failure. Carrying that through as a flag lets the UI say
// "Stock/ETF not found" instead of sending people to debug their connection.
export class ApiError extends Error {
  constructor(message, { status, code, symbol } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.symbol = symbol;
    this.notFound = code === "symbol_not_found";
  }
}

async function handle(r) {
  // The service worker sets x-sae-offline when it served a cached copy because
  // the network or the API failed. Surface it so the UI can say the numbers are
  // old rather than passing them off as live.
  if (r.headers?.get?.("x-sae-offline") === "1") {
    markStale(r.headers.get("x-sae-cached-at"));
  } else if (r.ok) {
    clearStale();
  }
  if (r.status === 401) { sessionStorage.removeItem(AUTH_KEY); window.location.reload(); }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new ApiError(
      body.detail || `Request failed (${r.status})`,
      { status: r.status, code: body.error, symbol: body.symbol }
    );
  }
  return r;
}

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return (await handle(r)).json();
}

async function get(path) {
  const r = await fetch(path, { headers: headers() });
  return (await handle(r)).json();
}

// POST that returns a file rather than JSON.
async function postBlob(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return (await handle(r)).blob();
}

export function analyze(symbols, period = "6mo") {
  return post("/api/analyze", { symbols, period });
}

export async function quotes(symbols) {
  const q = encodeURIComponent(symbols.join(","));
  try {
    const res = await get(`/api/quotes?symbols=${q}`);
    // Every response teaches us about every symbol in it, so a later request
    // for a different combination can still be answered offline.
    rememberQuotes(res.quotes);
    return res;
  } catch (e) {
    // Fall back to last-known prices rather than showing nothing. The caller
    // gets `stale: true` and each quote carries `_stale`, and the page shows a
    // banner with the age — a price is never passed off as live.
    const { quotes: cached, cachedAt } = cachedQuotes(symbols);
    if (!cached.length) throw e;
    markStale(cachedAt);
    return { quotes: cached, stale: true, cached_at: cachedAt };
  }
}

export async function insights(symbol) {
  return get(`/api/insights?symbol=${encodeURIComponent(symbol)}`);
}

export async function statistics(symbol) {
  return get(`/api/statistics?symbol=${encodeURIComponent(symbol)}`);
}

export async function fundamentals(symbol) {
  return get(`/api/fundamentals?symbol=${encodeURIComponent(symbol)}`);
}

export async function candles(symbol, period = "6mo", interval = "1d") {
  const q = new URLSearchParams({ symbol, period, interval });
  return get(`/api/candles?${q}`);
}

export function forecast(symbol, period = "1y", target = null, targetDays = 21) {
  const q = new URLSearchParams({ symbol, period });
  if (target) { q.set("target", target); q.set("target_days", targetDays); }
  return get(`/api/forecast?${q}`);
}

export function daytrade(symbol, opts = {}) {
  const q = new URLSearchParams({ symbol, interval: opts.interval || "5m" });
  if (opts.accountValue) q.set("account_value", opts.accountValue);
  if (opts.riskPct) q.set("risk_pct", opts.riskPct);
  if (opts.entry) q.set("entry", opts.entry);
  if (opts.stop) q.set("stop", opts.stop);
  return get(`/api/daytrade?${q}`);
}

export function holdings(symbol) {
  return get(`/api/holdings?symbol=${encodeURIComponent(symbol)}`);
}

export function portfolio(positions) {
  return post("/api/portfolio", { positions });
}

export function comparePositions(positions, period = "6mo", benchmark = "SPY") {
  return post("/api/portfolio/compare", { positions, period, benchmark });
}

export async function exportComparison(positions, period, benchmark, format = "csv") {
  const blob = await postBlob("/api/portfolio/compare/export",
    { positions, period, benchmark, format });
  saveBlob(blob, `performance_${period}.${format === "xlsx" ? "xlsx" : "csv"}`);
}

export function chat(messages, symbols, period = "6mo", mode = "standard", positions = []) {
  return post("/api/chat", { messages, symbols, period, mode, positions });
}

// --- exports -------------------------------------------------------------
// CSV and XLSX are the two supported spreadsheet formats; CSV is the default
// because it opens anywhere, XLSX when the file is meant to be kept and edited.
export async function exportPositions(positions, format = "csv") {
  const blob = await postBlob("/api/portfolio/export", { positions, format });
  saveBlob(blob, `holdings.${format === "xlsx" ? "xlsx" : "csv"}`);
}

export async function importPositions(file) {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch("/api/portfolio/import", {
    method: "POST", headers: headers(), body: form,
  });
  return (await handle(r)).json();
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function withKey(url) {
  const key = sessionStorage.getItem(AUTH_KEY);
  return key ? `${url}&api_key=${key}` : url;
}

export function downloadCsvUrl(symbols, period = "6mo") {
  const q = encodeURIComponent(symbols.join(","));
  return withKey(`/api/download.csv?symbols=${q}&period=${period}`);
}

export function downloadXlsxUrl(symbols, period = "6mo") {
  const q = encodeURIComponent(symbols.join(","));
  return withKey(`/api/export.xlsx?symbols=${q}&period=${period}`);
}

// --- new analytics -------------------------------------------------------
export function backtest(symbol, period = "5y", horizon = 21) {
  const q = new URLSearchParams({ symbol, period, horizon });
  return get(`/api/backtest?${q}`);
}

export function portfolioIncome(positions, period = "1y") {
  return post("/api/portfolio/income", { positions, period });
}

export function portfolioCorrelation(positions, period = "1y") {
  return post("/api/portfolio/correlation", { positions, period });
}

export function portfolioForecast(positions, period = "2y") {
  return post("/api/portfolio/forecast", { positions, period });
}

export function sellPosition({ positions, symbol, shares, price, soldOn, method, lotIds }) {
  return post("/api/portfolio/sell", {
    positions, symbol, shares, price,
    sold_on: soldOn || null, method: method || "fifo", lot_ids: lotIds || [],
  });
}

export function realizedGains(sales, positions = [], year = null) {
  return post("/api/portfolio/realized", { sales, positions, year });
}

export async function exportRealized(sales, format = "csv") {
  const blob = await postBlob("/api/portfolio/realized/export", { sales, format });
  saveBlob(blob, `realized_gains.${format === "xlsx" ? "xlsx" : "csv"}`);
}

// One click, one file. Everything the user has — watchlist analysis, holdings,
// performance, dividends and closed trades — as a single multi-sheet workbook,
// because "export my data" almost never means "give me six separate files".
export async function exportEverything({ symbols = [], positions = [], sales = [],
                                         period = "6mo", benchmark = "SPY" } = {}) {
  const blob = await postBlob("/api/export/all",
    { symbols, positions, sales, period, benchmark });
  const stamp = new Date().toISOString().slice(0, 10);
  saveBlob(blob, `stock-analysis-${stamp}.xlsx`);
}

// What kind of instrument this is, so panels can adapt instead of each
// re-deriving it (crypto has no P/E, a mutual fund has no intraday session).
export function asset(symbol) {
  return get(`/api/asset?symbol=${encodeURIComponent(symbol)}`);
}

// Read transaction history out of a photo. Returns rows for REVIEW — the
// caller must not save them without the user confirming, because OCR gets
// decimal points wrong and a wrong cost basis looks exactly like a right one.
export async function importPhoto(file, hint) {
  const form = new FormData();
  form.append("file", file);
  if (hint) form.append("hint", hint);
  const r = await fetch("/api/import/photo", {
    method: "POST", headers: headers(), body: form,
  });
  return (await handle(r)).json();
}

// Find a ticker from a company name — "nvidia" -> NVDA. Takes an AbortSignal
// because this fires while the user types and stale replies must not land.
export async function searchSymbols(q, limit = 8, signal) {
  const params = new URLSearchParams({ q, limit });
  const r = await fetch(`/api/search?${params}`, { headers: headers(), signal });
  return (await handle(r)).json();
}
