// Paper trading: practise buying and selling with pretend money.
//
// The best way for a beginner to learn how it FEELS to hold a stock that drops
// 5% — without it costing anything. Everything lives in this browser's
// localStorage; nothing is real and nothing is sent anywhere.
//
// The functions are pure (they take the account and return a new one) so they
// can be tested without a browser, and so React re-renders on every change.

export const START_CASH = 10000;
const LS_PAPER = "sae:paper";

export function newAccount(cash = START_CASH) {
  return { cash, start: cash, holdings: {}, history: [] };
}

export function loadAccount() {
  try {
    const a = JSON.parse(localStorage.getItem(LS_PAPER) || "null");
    if (a && typeof a.cash === "number" && a.holdings) return a;
  } catch { /* fall through */ }
  return newAccount();
}

export function saveAccount(a) {
  try { localStorage.setItem(LS_PAPER, JSON.stringify(a)); } catch { /* private mode */ }
  return a;
}

class PaperError extends Error {}

/** Buy `shares` of `symbol` at `price`. Throws a readable error if you can't. */
export function buy(account, symbol, shares, price, at = new Date().toISOString()) {
  const n = Number(shares);
  const p = Number(price);
  if (!(n > 0) || !(p > 0)) throw new PaperError("Enter a number of shares above zero.");
  const cost = n * p;
  if (cost > account.cash + 1e-9) {
    throw new PaperError(`That costs $${cost.toFixed(2)} but you only have $${account.cash.toFixed(2)}.`);
  }
  const h = account.holdings[symbol] || { shares: 0, cost: 0 };
  return {
    ...account,
    cash: account.cash - cost,
    holdings: { ...account.holdings, [symbol]: { shares: h.shares + n, cost: h.cost + cost } },
    history: [{ side: "buy", symbol, shares: n, price: p, at }, ...account.history].slice(0, 200),
  };
}

/** Sell `shares` of `symbol` at `price`. Returns the account and the profit made. */
export function sell(account, symbol, shares, price, at = new Date().toISOString()) {
  const n = Number(shares);
  const p = Number(price);
  const h = account.holdings[symbol];
  if (!(n > 0) || !(p > 0)) throw new PaperError("Enter a number of shares above zero.");
  if (!h || h.shares < n - 1e-9) {
    throw new PaperError(`You only own ${h ? h.shares : 0} shares of ${symbol}.`);
  }
  // Average-cost method: each share sold carries the average price you paid.
  const avgCost = h.cost / h.shares;
  const profit = (p - avgCost) * n;
  const left = h.shares - n;
  const holdings = { ...account.holdings };
  if (left > 1e-9) holdings[symbol] = { shares: left, cost: avgCost * left };
  else delete holdings[symbol];
  return {
    account: {
      ...account,
      cash: account.cash + n * p,
      holdings,
      history: [{ side: "sell", symbol, shares: n, price: p, profit, at }, ...account.history].slice(0, 200),
    },
    profit,
  };
}

/** Total value at current prices, and how that compares with the start. */
export function valueAccount(account, priceBySymbol = {}) {
  let invested = 0;
  for (const [sym, h] of Object.entries(account.holdings)) {
    // No live price yet? Value it at what you paid rather than at zero.
    invested += priceBySymbol[sym] != null ? h.shares * priceBySymbol[sym] : h.cost;
  }
  const total = account.cash + invested;
  return {
    cash: account.cash,
    invested,
    total,
    gain: total - account.start,
    gainPct: ((total - account.start) / account.start) * 100,
  };
}
