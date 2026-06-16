// Thin client for the FastAPI backend. All calls go through Vite's /api proxy.

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed (${r.status})`);
  }
  return r.json();
}

export function analyze(symbols, period = "6mo") {
  return post("/api/analyze", { symbols, period });
}

export function chat(messages, symbols, period = "6mo") {
  return post("/api/chat", { messages, symbols, period });
}

// Download is a plain GET so the browser handles the file save natively.
export function downloadCsvUrl(symbols, period = "6mo") {
  const q = encodeURIComponent(symbols.join(","));
  return `/api/download.csv?symbols=${q}&period=${period}`;
}
