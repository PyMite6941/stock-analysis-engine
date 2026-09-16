// Price and position alerts. Entirely client-side.
//
// No server, no push infrastructure, no account: the app already polls quotes
// every 30s and holds a live WebSocket, so alerts are just a predicate checked
// against data that's arriving anyway. That keeps the whole feature free and
// means nothing about what you watch leaves the browser.
//
// The cost of that choice is honest and stated in the UI: alerts only fire while
// a tab is open. This is not a substitute for a broker's alerts.

const LS_ALERTS = "sae:alerts";
const LS_FIRED = "sae:alerts_fired";
const MAX_ALERTS = 50;

export const TYPES = {
  price_above: { label: "Price rises above", unit: "$", needsSymbol: true },
  price_below: { label: "Price falls below", unit: "$", needsSymbol: true },
  pct_up: { label: "Up today by", unit: "%", needsSymbol: true },
  pct_down: { label: "Down today by", unit: "%", needsSymbol: true },
  position_gain: { label: "My position gains", unit: "%", needsSymbol: true },
  position_loss: { label: "My position loses", unit: "%", needsSymbol: true },
  portfolio_gain: { label: "Whole portfolio gains", unit: "%", needsSymbol: false },
  portfolio_loss: { label: "Whole portfolio loses", unit: "%", needsSymbol: false },
};

function uid() {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function loadAlerts() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_ALERTS) || "[]");
    return Array.isArray(raw) ? raw.filter(isValid) : [];
  } catch {
    return [];
  }
}

function persist(list) {
  try {
    localStorage.setItem(LS_ALERTS, JSON.stringify(list.slice(0, MAX_ALERTS)));
  } catch { /* private mode — in-memory only for this session */ }
  return list.slice(0, MAX_ALERTS);
}

function isValid(a) {
  return Boolean(
    a && a.id && a.type && TYPES[a.type]
    && Number.isFinite(Number(a.threshold))
    && (!TYPES[a.type].needsSymbol || a.symbol)
  );
}

export function addAlert(list, entry) {
  const a = {
    id: uid(),
    type: entry.type,
    symbol: entry.symbol ? String(entry.symbol).trim().toUpperCase() : null,
    threshold: Number(entry.threshold),
    note: entry.note || null,
    // A repeating alert re-arms after firing; a one-shot disables itself.
    repeat: Boolean(entry.repeat),
    enabled: true,
    created: Date.now(),
    lastFired: null,
  };
  if (!isValid(a)) return list;
  return persist([...list, a]);
}

export function removeAlert(list, id) {
  return persist(list.filter((a) => a.id !== id));
}

export function toggleAlert(list, id) {
  return persist(list.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
}

export function clearAlerts() {
  return persist([]);
}

export function symbolsOf(list) {
  return [...new Set(list.map((a) => a.symbol).filter(Boolean))];
}

// --- evaluation ----------------------------------------------------------
/**
 * Check every enabled alert against the current data.
 *
 * `quotes` is {SYMBOL: {price, change_pct}}, `positionRows` is the valued
 * holdings, `portfolio` is the summary. Returns {triggered, alerts} where
 * `alerts` is the updated list (fired one-shots disabled, lastFired stamped).
 */
export function evaluate(list, { quotes = {}, positionRows = [], portfolio = null } = {}) {
  const triggered = [];
  const now = Date.now();

  const bySymbol = {};
  for (const r of positionRows) {
    if (!r.symbol) continue;
    const agg = bySymbol[r.symbol] || { cost: 0, value: 0 };
    agg.cost += r.cost || 0;
    agg.value += r.market_value || 0;
    bySymbol[r.symbol] = agg;
  }

  const next = list.map((a) => {
    if (!a.enabled) return a;
    // Re-arming guard: a repeating alert shouldn't fire on every single poll
    // while the condition stays true.
    if (a.repeat && a.lastFired && now - a.lastFired < 60 * 60 * 1000) return a;

    const q = a.symbol ? quotes[a.symbol] : null;
    const pos = a.symbol ? bySymbol[a.symbol] : null;
    let hit = false;
    let actual = null;

    switch (a.type) {
      case "price_above":
        if (q?.price != null) { actual = q.price; hit = q.price >= a.threshold; }
        break;
      case "price_below":
        if (q?.price != null) { actual = q.price; hit = q.price <= a.threshold; }
        break;
      case "pct_up":
        if (q?.change_pct != null) { actual = q.change_pct; hit = q.change_pct >= a.threshold; }
        break;
      case "pct_down":
        if (q?.change_pct != null) { actual = q.change_pct; hit = q.change_pct <= -Math.abs(a.threshold); }
        break;
      case "position_gain":
        if (pos?.cost) {
          actual = ((pos.value - pos.cost) / pos.cost) * 100;
          hit = actual >= a.threshold;
        }
        break;
      case "position_loss":
        if (pos?.cost) {
          actual = ((pos.value - pos.cost) / pos.cost) * 100;
          hit = actual <= -Math.abs(a.threshold);
        }
        break;
      case "portfolio_gain":
        if (portfolio?.total_pnl_pct != null) {
          actual = portfolio.total_pnl_pct;
          hit = actual >= a.threshold;
        }
        break;
      case "portfolio_loss":
        if (portfolio?.total_pnl_pct != null) {
          actual = portfolio.total_pnl_pct;
          hit = actual <= -Math.abs(a.threshold);
        }
        break;
      default:
        break;
    }

    if (!hit) return a;
    triggered.push({ ...a, actual, message: describe(a, actual) });
    return { ...a, lastFired: now, enabled: a.repeat };
  });

  return { triggered, alerts: triggered.length ? persist(next) : list };
}

export function describe(a, actual = null) {
  const t = TYPES[a.type];
  const who = a.symbol || "Portfolio";
  const unit = t.unit === "$" ? "$" : "";
  const suffix = t.unit === "%" ? "%" : "";
  const target = `${unit}${a.threshold}${suffix}`;
  const now = actual == null ? ""
    : ` (now ${unit}${Number(actual).toFixed(2)}${suffix})`;
  return `${who}: ${t.label.toLowerCase()} ${target}${now}`;
}

export function label(a) {
  const t = TYPES[a.type];
  const unit = t.unit === "$" ? "$" : "";
  const suffix = t.unit === "%" ? "%" : "";
  return `${a.symbol || "Portfolio"} — ${t.label.toLowerCase()} ${unit}${a.threshold}${suffix}`;
}

// --- browser notifications ------------------------------------------------
export function notificationPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestNotifications() {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export function notify(alert) {
  // Always returns; the in-app banner is the primary surface and the OS
  // notification is a bonus that may be blocked.
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("Stock Analysis Engine", {
        body: alert.message,
        tag: alert.id,          // replaces rather than stacks duplicates
      });
    }
  } catch { /* some browsers throw on construction in insecure contexts */ }
}

// A short rolling log so a fired alert isn't lost if you were on another tab.
export function loadFired() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_FIRED) || "[]");
    return Array.isArray(raw) ? raw.slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function recordFired(entries) {
  const list = [
    ...entries.map((e) => ({ id: e.id, message: e.message, at: Date.now() })),
    ...loadFired(),
  ].slice(0, 20);
  try {
    localStorage.setItem(LS_FIRED, JSON.stringify(list));
  } catch { /* ignore */ }
  return list;
}

export function clearFired() {
  try { localStorage.setItem(LS_FIRED, "[]"); } catch { /* ignore */ }
  return [];
}
