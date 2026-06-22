// Thin client for the FastAPI backend. All calls go through Vite's /api proxy.

const AUTH_KEY = "sae:api_key";

function headers(extra = {}) {
  const key = sessionStorage.getItem(AUTH_KEY);
  if (key) extra["Authorization"] = `Bearer ${key}`;
  return { ...extra };
}

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (r.status === 401) { sessionStorage.removeItem(AUTH_KEY); window.location.reload(); }
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed (${r.status})`);
  }
  return r.json();
}

async function get(path) {
  const r = await fetch(path, { headers: headers() });
  if (r.status === 401) { sessionStorage.removeItem(AUTH_KEY); window.location.reload(); }
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed (${r.status})`);
  }
  return r.json();
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

export function chat(messages, symbols, period = "6mo") {
  return post("/api/chat", { messages, symbols, period });
}

export function downloadCsvUrl(symbols, period = "6mo") {
  const q = encodeURIComponent(symbols.join(","));
  const url = `/api/download.csv?symbols=${q}&period=${period}`;
  const key = sessionStorage.getItem(AUTH_KEY);
  if (key) return url + `&api_key=${key}`;
  return url;
}
