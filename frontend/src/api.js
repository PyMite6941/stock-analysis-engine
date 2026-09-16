// Thin client for the FastAPI backend. All calls go through Vite's /api proxy.

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
  return get(`/api/quotes?symbols=${q}`);
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
