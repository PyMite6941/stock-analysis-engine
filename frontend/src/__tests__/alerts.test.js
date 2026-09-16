import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  TYPES, addAlert, clearAlerts, evaluate, label, loadAlerts, removeAlert,
  symbolsOf, toggleAlert,
} from "../alerts.js";
import { addSales, loadSales, removeSale, salesToCsv } from "../sales.js";

function installStorage(initial = {}) {
  const store = { ...initial };
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
  return store;
}

describe("alerts store", () => {
  beforeEach(() => { installStorage(); });

  it("adds a valid alert", () => {
    const list = addAlert([], { type: "price_above", symbol: "aapl", threshold: "350" });
    expect(list).toHaveLength(1);
    expect(list[0].symbol).toBe("AAPL");
    expect(list[0].threshold).toBe(350);
    expect(list[0].enabled).toBe(true);
  });

  it("rejects an alert missing its symbol", () => {
    expect(addAlert([], { type: "price_above", threshold: 10 })).toHaveLength(0);
  });

  it("rejects a non-numeric threshold", () => {
    expect(addAlert([], { type: "price_above", symbol: "A", threshold: "abc" }))
      .toHaveLength(0);
  });

  it("allows portfolio alerts with no symbol", () => {
    const list = addAlert([], { type: "portfolio_loss", threshold: 10 });
    expect(list).toHaveLength(1);
    expect(TYPES.portfolio_loss.needsSymbol).toBe(false);
  });

  it("toggles and removes", () => {
    let list = addAlert([], { type: "price_above", symbol: "A", threshold: 1 });
    list = toggleAlert(list, list[0].id);
    expect(list[0].enabled).toBe(false);
    expect(removeAlert(list, list[0].id)).toHaveLength(0);
  });

  it("persists and reloads", () => {
    addAlert([], { type: "price_below", symbol: "MSFT", threshold: 300 });
    expect(loadAlerts()).toHaveLength(1);
    clearAlerts();
    expect(loadAlerts()).toHaveLength(0);
  });

  it("survives corrupt storage", () => {
    installStorage({ "sae:alerts": "not json" });
    expect(loadAlerts()).toEqual([]);
  });

  it("lists the symbols it watches", () => {
    let list = addAlert([], { type: "price_above", symbol: "A", threshold: 1 });
    list = addAlert(list, { type: "price_below", symbol: "B", threshold: 1 });
    list = addAlert(list, { type: "portfolio_gain", threshold: 5 });
    expect(symbolsOf(list)).toEqual(["A", "B"]);
  });

  it("labels an alert readably", () => {
    const list = addAlert([], { type: "price_above", symbol: "AAPL", threshold: 350 });
    expect(label(list[0])).toContain("AAPL");
    expect(label(list[0])).toContain("$350");
  });
});

describe("alert evaluation", () => {
  beforeEach(() => { installStorage(); });

  it("fires when price rises above the threshold", () => {
    const list = addAlert([], { type: "price_above", symbol: "AAPL", threshold: 330 });
    const { triggered } = evaluate(list, { quotes: { AAPL: { price: 331.34 } } });
    expect(triggered).toHaveLength(1);
    expect(triggered[0].message).toContain("AAPL");
  });

  it("does not fire below the threshold", () => {
    const list = addAlert([], { type: "price_above", symbol: "AAPL", threshold: 400 });
    expect(evaluate(list, { quotes: { AAPL: { price: 331 } } }).triggered).toHaveLength(0);
  });

  it("fires on a price drop", () => {
    const list = addAlert([], { type: "price_below", symbol: "AAPL", threshold: 340 });
    expect(evaluate(list, { quotes: { AAPL: { price: 331 } } }).triggered).toHaveLength(1);
  });

  it("treats a down-percent threshold as a magnitude", () => {
    // Entering "5" for a 5% fall should fire at -5%, not require -5 > threshold.
    const list = addAlert([], { type: "pct_down", symbol: "X", threshold: 5 });
    expect(evaluate(list, { quotes: { X: { change_pct: -6 } } }).triggered).toHaveLength(1);
    expect(evaluate(list, { quotes: { X: { change_pct: -2 } } }).triggered).toHaveLength(0);
  });

  it("fires on position gain using cost basis", () => {
    const list = addAlert([], { type: "position_gain", symbol: "NVDA", threshold: 15 });
    const { triggered } = evaluate(list, {
      quotes: { NVDA: { price: 212.17 } },
      positionRows: [{ symbol: "NVDA", cost: 71400, market_value: 84868 }],
    });
    expect(triggered).toHaveLength(1);       // +18.86%
    expect(triggered[0].actual).toBeCloseTo(18.86, 1);
  });

  it("fires on whole-portfolio loss", () => {
    const list = addAlert([], { type: "portfolio_loss", threshold: 10 });
    const { triggered } = evaluate(list, { portfolio: { total_pnl_pct: -12 } });
    expect(triggered).toHaveLength(1);
  });

  it("skips disabled alerts", () => {
    let list = addAlert([], { type: "price_above", symbol: "A", threshold: 1 });
    list = toggleAlert(list, list[0].id);
    expect(evaluate(list, { quotes: { A: { price: 100 } } }).triggered).toHaveLength(0);
  });

  it("one-shot alerts disable themselves after firing", () => {
    const list = addAlert([], { type: "price_above", symbol: "A", threshold: 1 });
    const { alerts } = evaluate(list, { quotes: { A: { price: 100 } } });
    expect(alerts[0].enabled).toBe(false);
    expect(alerts[0].lastFired).toBeTruthy();
  });

  it("repeating alerts stay armed but do not re-fire immediately", () => {
    const list = addAlert([], {
      type: "price_above", symbol: "A", threshold: 1, repeat: true,
    });
    const first = evaluate(list, { quotes: { A: { price: 100 } } });
    expect(first.triggered).toHaveLength(1);
    expect(first.alerts[0].enabled).toBe(true);

    // Second poll with the condition still true must not spam.
    const second = evaluate(first.alerts, { quotes: { A: { price: 100 } } });
    expect(second.triggered).toHaveLength(0);
  });

  it("ignores alerts whose symbol has no quote", () => {
    const list = addAlert([], { type: "price_above", symbol: "GONE", threshold: 1 });
    expect(evaluate(list, { quotes: { OTHER: { price: 5 } } }).triggered).toHaveLength(0);
  });

  it("handles an empty call safely", () => {
    expect(evaluate([], {}).triggered).toEqual([]);
  });
});

describe("sales store", () => {
  beforeEach(() => { installStorage(); });

  const SALE = {
    symbol: "nvda", shares: 100, cost_basis: 178.5, exit_price: 212.17,
    opened: "2026-09-01", closed: "2026-09-16 14:20",
  };

  it("adds and normalises a sale", () => {
    const list = addSales([], SALE);
    expect(list[0].symbol).toBe("NVDA");
    expect(list[0].id).toBeTruthy();
    // The clock time on the close must survive — it drives the holding period.
    expect(list[0].closed).toBe("2026-09-16 14:20");
  });

  it("accepts several sales at once", () => {
    expect(addSales([], [SALE, { ...SALE, symbol: "AAPL" }])).toHaveLength(2);
  });

  it("drops unusable rows", () => {
    expect(addSales([], { symbol: "X" })).toHaveLength(0);
    expect(addSales([], { ...SALE, shares: 0 })).toHaveLength(0);
  });

  it("removes and reloads", () => {
    const list = addSales([], SALE);
    expect(removeSale(list, list[0].id)).toHaveLength(0);
    expect(loadSales()).toHaveLength(0);
  });

  it("exports CSV with a header", () => {
    const csv = salesToCsv(addSales([], SALE));
    expect(csv.split("\n")[0]).toContain("symbol");
    expect(csv).toContain("NVDA");
    expect(csv).toContain("2026-09-16 14:20");
  });

  it("survives corrupt storage", () => {
    installStorage({ "sae:sales": "{{{" });
    expect(loadSales()).toEqual([]);
  });
});
