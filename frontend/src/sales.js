// Closed trades. Sits alongside positions.js: that file holds what you still
// own, this one holds what you've sold and what it made.
//
// Same storage contract — localStorage only, no cookies, nothing uploaded.

const LS_SALES = "sae:sales";
const MAX_SALES = 500;

function uid() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function isUsable(s) {
  const n = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  return Boolean(s && s.symbol && n(s.shares) && Number(s.shares) > 0
    && n(s.cost_basis) && n(s.exit_price));
}

function normalize(s) {
  return {
    id: s.id || uid(),
    symbol: String(s.symbol).trim().toUpperCase(),
    shares: Number(s.shares),
    cost_basis: Number(s.cost_basis),
    exit_price: Number(s.exit_price),
    // Both may carry a clock time ("2026-09-16 14:20") for intraday trades.
    opened: s.opened || null,
    closed: s.closed || null,
    note: s.note || null,
  };
}

export function loadSales() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SALES) || "[]");
    return Array.isArray(raw) ? raw.filter(isUsable).map(normalize) : [];
  } catch {
    return [];
  }
}

export function saveSales(list) {
  try {
    localStorage.setItem(LS_SALES, JSON.stringify(list.slice(-MAX_SALES)));
  } catch { /* private mode — in-memory only */ }
  return list.slice(-MAX_SALES);
}

export function addSales(list, entries) {
  const rows = (Array.isArray(entries) ? entries : [entries])
    .filter(isUsable).map((e) => normalize({ ...e, id: uid() }));
  return saveSales([...list, ...rows]);
}

export function removeSale(list, id) {
  return saveSales(list.filter((s) => s.id !== id));
}

export function clearSales() {
  return saveSales([]);
}

export function salesToCsv(list) {
  const cols = ["symbol", "shares", "cost_basis", "exit_price", "opened", "closed", "note"];
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(",")]
    .concat(list.map((r) => cols.map((c) => esc(r[c])).join(",")))
    .join("\n");
}
