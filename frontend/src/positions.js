// Holdings store. The browser owns the list; core/positions.py owns the maths.
//
// localStorage rather than a database because the app is deliberately stateless
// and account-free — your buys never leave your machine unless you export them.
// The trade-off is that clearing site data loses the list, which is exactly why
// the export button is prominent.

const LS_POSITIONS = "sae:positions";

function uid() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadPositions() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_POSITIONS) || "[]");
    return Array.isArray(raw) ? raw.filter(isUsable).map(normalize) : [];
  } catch {
    // Corrupt entry shouldn't wipe the UI — start empty and let the user re-import.
    return [];
  }
}

export function savePositions(list) {
  try {
    localStorage.setItem(LS_POSITIONS, JSON.stringify(list));
  } catch {
    /* quota or private mode — the in-memory list still works this session */
  }
  return list;
}

// Number("") and Number(null) are both 0, which is finite — so checking
// Number.isFinite alone lets blank spreadsheet cells through as zero-share lots.
function isNumber(v) {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "string" && !v.trim()) return false;
  return Number.isFinite(Number(v));
}

function isUsable(p) {
  return Boolean(
    p && p.symbol && String(p.symbol).trim()
    && isNumber(p.shares) && Number(p.shares) !== 0
    && isNumber(p.cost_basis) && Number(p.cost_basis) >= 0
  );
}

function normalize(p) {
  return {
    id: p.id || uid(),
    symbol: String(p.symbol).trim().toUpperCase(),
    shares: Number(p.shares),
    cost_basis: Number(p.cost_basis),
    opened: p.opened || null,
    note: p.note || null,
  };
}

export function addPosition(list, entry) {
  if (!isUsable(entry)) return list;
  return savePositions([...list, normalize({ ...entry, id: uid() })]);
}

export function updatePosition(list, id, patch) {
  return savePositions(list.map((p) => (p.id === id ? normalize({ ...p, ...patch, id }) : p)));
}

export function removePosition(list, id) {
  return savePositions(list.filter((p) => p.id !== id));
}

export function replacePositions(entries) {
  return savePositions((entries || []).filter(isUsable).map((e) => normalize({ ...e, id: e.id || uid() })));
}

export function mergePositions(list, entries) {
  // Import appends rather than replaces: someone importing a broker file on top
  // of hand-entered lots almost never means "delete what I typed".
  const incoming = (entries || []).filter(isUsable).map((e) => normalize({ ...e, id: uid() }));
  return savePositions([...list, ...incoming]);
}

export function symbolsOf(list) {
  return [...new Set(list.map((p) => p.symbol))];
}

// Client-side mirror of core/positions.value_position, used only to keep P/L
// moving between server refreshes when a live tick arrives. The server's numbers
// win whenever they're available.
export function markToMarket(list, priceBySymbol) {
  let cost = 0;
  let value = 0;
  const rows = list.map((p) => {
    const price = priceBySymbol[p.symbol];
    const lotCost = p.shares * p.cost_basis;
    cost += lotCost;
    if (!price) return { ...p, cost: lotCost, price: null, market_value: null, pnl: null };
    const mv = p.shares * price;
    value += mv;
    return {
      ...p,
      cost: lotCost,
      price,
      market_value: mv,
      pnl: mv - lotCost,
      pnl_pct: lotCost ? ((mv - lotCost) / lotCost) * 100 : null,
    };
  });
  return {
    rows,
    total_cost: cost,
    total_value: value,
    total_pnl: value - cost,
    total_pnl_pct: cost ? ((value - cost) / cost) * 100 : null,
  };
}

// --- local file export ---------------------------------------------------
// CSV is generated here as well as on the server so the button still works when
// the backend is unreachable — the list is local data, it shouldn't need a
// round trip to save.
const CSV_COLUMNS = ["symbol", "shares", "cost_basis", "opened", "note"];

export function positionsToCsv(list) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(",")]
    .concat(list.map((p) => CSV_COLUMNS.map((c) => esc(p[c])).join(",")))
    .join("\n");
}

export function parseCsv(text) {
  // Minimal RFC-4180 reader: handles quoted fields and embedded commas, which
  // is all a holdings file needs.
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

const ALIASES = {
  symbol: "symbol", ticker: "symbol", stock: "symbol",
  shares: "shares", quantity: "shares", qty: "shares", units: "shares",
  cost_basis: "cost_basis", "cost basis": "cost_basis", "avg cost": "cost_basis",
  "average cost": "cost_basis", "buy price": "cost_basis", price: "cost_basis",
  "purchase price": "cost_basis", "cost per share": "cost_basis",
  opened: "opened", date: "opened", "buy date": "opened", "trade date": "opened",
  note: "note", notes: "note",
};

export function csvToPositions(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => ALIASES[String(h).trim().toLowerCase()] || null);
  if (!header.includes("symbol")) {
    throw new Error("No symbol/ticker column found in that CSV.");
  }
  // First match wins per field, so a file with both cost_basis and price keeps
  // the real cost basis.
  const cols = {};
  header.forEach((field, i) => { if (field && !(field in cols)) cols[field] = i; });

  return rows.slice(1).map((r) => {
    const num = (v) => {
      const cleaned = String(v ?? "").replace(/[$,%\s]/g, "");
      if (!cleaned) return null;                    // blank cell, not zero
      // Accounting-style negatives: (12.00) means -12.00
      const negative = /^\(.*\)$/.test(cleaned);
      const n = Number(negative ? cleaned.slice(1, -1) : cleaned);
      if (!Number.isFinite(n)) return null;
      return negative ? -n : n;
    };
    return {
      symbol: String(r[cols.symbol] ?? "").trim().toUpperCase(),
      shares: num(r[cols.shares]),
      cost_basis: num(r[cols.cost_basis]),
      opened: cols.opened !== undefined ? String(r[cols.opened] ?? "").trim() || null : null,
      note: cols.note !== undefined ? String(r[cols.note] ?? "").trim() || null : null,
    };
  }).filter(isUsable);
}
