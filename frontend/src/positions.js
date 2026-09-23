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
    // Why you'd sell, written while you still have no position to defend.
    // Separate from `note` on purpose: the reason you bought and the condition
    // that would change your mind are different thoughts, and merging them
    // into one box means the second never gets written.
    exit_plan: p.exit_plan || null,
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
  // Totals count PRICED lots only, on both sides. Adding an unpriced lot's
  // cost while its value stayed 0 reported it as a 100% loss and dragged the
  // portfolio P/L down by the whole position. core/positions.py does the same.
  let cost = 0;
  let value = 0;
  const rows = list.map((p) => {
    const price = priceBySymbol[p.symbol];
    const lotCost = p.shares * p.cost_basis;
    if (!price) return { ...p, cost: lotCost, price: null, market_value: null, pnl: null };
    cost += lotCost;
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
const CSV_COLUMNS = ["symbol", "shares", "cost_basis", "opened", "note",
                     "exit_plan"];

export function positionsToCsv(list) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(",")]
    .concat(list.map((p) => CSV_COLUMNS.map((c) => esc(p[c])).join(",")))
    .join("\n");
}

// Excel writes semicolons wherever the comma is the decimal separator, and
// plenty of exports are tab-separated. Sniffing turns a hard failure into a
// successful import.
export function sniffDelimiter(text) {
  const first = text.split("\n").find((l) => l.trim()) || "";
  const counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  for (const d of Object.keys(counts)) counts[d] = first.split(d).length - 1;
  const best = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a));
  return counts[best] ? best : ",";
}

export function parseCsv(text, delimiter) {
  // Minimal RFC-4180 reader: handles quoted fields and embedded separators,
  // which is all a holdings file needs.
  const sep = delimiter || sniffDelimiter(text);
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
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

// Kept deliberately in step with _ALIASES in backend/exports.py: a .csv is
// parsed here and an .xlsx on the server, and the same file must not produce
// two different portfolios depending on which extension it happens to have.
// [field, priority] — priority breaks ties when one file has several columns
// for the same field.
const ALIASES = {
  symbol: ["symbol", 10], ticker: ["symbol", 9], stock: ["symbol", 5],
  security: ["symbol", 4], instrument: ["symbol", 4],

  shares: ["shares", 10], quantity: ["shares", 9], qty: ["shares", 9],
  units: ["shares", 6], "no of shares": ["shares", 8], amount: ["shares", 2],

  "cost basis per share": ["cost_basis", 10],
  "average cost basis": ["cost_basis", 10],
  "cost per share": ["cost_basis", 10],
  "price per share": ["cost_basis", 10],
  "share price": ["cost_basis", 9],
  "average cost": ["cost_basis", 9], "avg cost": ["cost_basis", 9],
  "avg price": ["cost_basis", 9], "average price": ["cost_basis", 9],
  "unit cost": ["cost_basis", 9],
  "purchase price": ["cost_basis", 8], "buy price": ["cost_basis", 8],
  "entry price": ["cost_basis", 7], entry: ["cost_basis", 6],
  // AMBIGUOUS: Schwab's "Cost Basis" is the lot TOTAL, Fidelity's is per share.
  "cost basis": ["cost_basis", 5],
  price: ["cost_basis", 1],

  "total cost": ["total_cost", 10],
  "total cost basis": ["total_cost", 10],
  "cost basis total": ["total_cost", 10],

  "last price": ["price_hint", 10], "current price": ["price_hint", 10],
  "market price": ["price_hint", 9], last: ["price_hint", 5],

  opened: ["opened", 10], "buy date": ["opened", 9],
  "purchase date": ["opened", 9], "trade date": ["opened", 9],
  acquired: ["opened", 8], date: ["opened", 4],

  note: ["note", 10], notes: ["note", 10],
  comment: ["note", 6], memo: ["note", 6],

  exit_plan: ["exit_plan", 10], "exit plan": ["exit_plan", 10],
  "sell plan": ["exit_plan", 9], "exit strategy": ["exit_plan", 9],
  thesis: ["exit_plan", 5],
};

const PRICE_ISH = new Set(["price", "last", "last price", "current price",
                           "market price", "share price"]);

function lookupAlias(header) {
  const key = String(header ?? "").trim().toLowerCase();
  return ALIASES[key.replace(/_/g, " ").trim()] || ALIASES[key] || null;
}

function mapHeader(headerRow) {
  const best = {};                 // field -> [priority, index]
  const losers = [];               // [index, rawHeader]
  headerRow.forEach((h, i) => {
    const hit = lookupAlias(h);
    if (!hit) return;
    const [field, priority] = hit;
    if (!(field in best) || priority > best[field][0]) {
      if (field in best) losers.push([best[field][1], headerRow[best[field][1]]]);
      best[field] = [priority, i];
    } else {
      losers.push([i, h]);
    }
  });

  const cols = {};
  for (const [field, [, idx]] of Object.entries(best)) cols[field] = idx;

  // A price column that lost the cost-basis contest still tells us whether the
  // winner was per-share or a lot total. Dropping it is what let Schwab's
  // total import as a per-share figure — 25x too high, and entirely silent.
  if (cols.price_hint === undefined) {
    const hint = losers.find(([, raw]) =>
      PRICE_ISH.has(String(raw ?? "").trim().toLowerCase().replace(/_/g, " ")));
    if (hint) cols.price_hint = hint[0];
  }
  return cols;
}

/** Resolve whatever the file gave us into a PER-SHARE cost basis. */
function resolveCostBasis(rec, ambiguous) {
  const shares = rec.shares;
  if (!shares) return;

  if (rec.total_cost && (rec.cost_basis === null || ambiguous)) {
    rec.cost_basis = Math.abs(rec.total_cost / shares);
    return;
  }
  const hint = rec.price_hint;
  if (rec.cost_basis === null || !hint || hint <= 0) return;

  const perShare = Math.abs(rec.cost_basis / shares);
  const near = Math.abs(perShare - hint) / hint < 0.5;
  const far = Math.abs(Math.abs(rec.cost_basis) - hint) / hint > 0.5;
  if (near && far) rec.cost_basis = perShare;
}

export function csvToPositions(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const cols = mapHeader(rows[0]);
  if (cols.symbol === undefined) {
    throw new Error("No symbol/ticker column found in that CSV.");
  }
  const ambiguous = cols.cost_basis !== undefined &&
    ["cost basis", "price"].includes(
      String(rows[0][cols.cost_basis] ?? "").trim().toLowerCase());

  const num = (v) => {
    const cleaned = String(v ?? "").replace(/[$,%\s]/g, "");
    if (!cleaned) return null;                    // blank cell, not zero
    // Accounting-style negatives: (12.00) means -12.00
    const negative = /^\(.*\)$/.test(cleaned);
    const n = Number(negative ? cleaned.slice(1, -1) : cleaned);
    if (!Number.isFinite(n)) return null;
    return negative ? -n : n;
  };
  const str = (r, i) => (i === undefined ? null : String(r[i] ?? "").trim() || null);

  return rows.slice(1).map((r) => {
    const rec = {
      symbol: String(r[cols.symbol] ?? "").trim().toUpperCase(),
      shares: num(r[cols.shares]),
      cost_basis: num(r[cols.cost_basis]),
      total_cost: num(r[cols.total_cost]),
      price_hint: num(r[cols.price_hint]),
      opened: str(r, cols.opened),
      note: str(r, cols.note),
      exit_plan: str(r, cols.exit_plan),
    };
    resolveCostBasis(rec, ambiguous);
    delete rec.total_cost;
    delete rec.price_hint;
    if (rec.cost_basis !== null) rec.cost_basis = Math.round(rec.cost_basis * 1e6) / 1e6;
    return rec;
  }).filter(isUsable);
}
