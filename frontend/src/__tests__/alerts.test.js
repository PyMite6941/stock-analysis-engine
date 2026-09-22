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

describe("alert false positives", () => {
  beforeEach(() => { installStorage(); });

  it("does not fire a position-loss alert for an UNPRICED holding", () => {
    // Regression: AnalysisView passed market_value 0 when a holding had no
    // quote, which reads as -100% and fired every position_loss alert at once.
    const list = addAlert([], { type: "position_loss", symbol: "NVDA", threshold: 10 });
    const { triggered } = evaluate(list, {
      quotes: {},
      positionRows: [],          // unpriced holdings are filtered out upstream
    });
    expect(triggered).toHaveLength(0);
  });

  it("still fires when the holding IS priced and really is down", () => {
    const list = addAlert([], { type: "position_loss", symbol: "NVDA", threshold: 10 });
    const { triggered } = evaluate(list, {
      quotes: { NVDA: { price: 100 } },
      positionRows: [{ symbol: "NVDA", cost: 1000, market_value: 800 }],
    });
    expect(triggered).toHaveLength(1);
    expect(triggered[0].actual).toBeCloseTo(-20, 1);
  });

  it("ignores a position row with zero cost rather than dividing by it", () => {
    const list = addAlert([], { type: "position_gain", symbol: "X", threshold: 5 });
    const { triggered } = evaluate(list, {
      quotes: { X: { price: 10 } },
      positionRows: [{ symbol: "X", cost: 0, market_value: 100 }],
    });
    expect(triggered).toHaveLength(0);
  });
});

describe("markToMarket totals", () => {
  beforeEach(() => { installStorage(); });

  it("excludes an unpriced lot from BOTH cost and value", async () => {
    // Regression: cost included the unpriced lot while value did not, so one
    // unquotable holding reported as a total loss of its full cost.
    const { markToMarket } = await import("../positions.js");
    const out = markToMarket(
      [{ symbol: "NVDA", shares: 10, cost_basis: 100 },
       { symbol: "NOQUOTE", shares: 10, cost_basis: 500 }],
      { NVDA: 120 });
    expect(out.total_cost).toBe(1000);        // NOQUOTE's 5000 excluded
    expect(out.total_value).toBe(1200);
    expect(out.total_pnl).toBe(200);          // was -4800 before the fix
    expect(out.total_pnl_pct).toBeCloseTo(20, 5);
  });

  it("still lists the unpriced lot with its cost, just unvalued", async () => {
    const { markToMarket } = await import("../positions.js");
    const out = markToMarket(
      [{ symbol: "NOQUOTE", shares: 10, cost_basis: 500 }], {});
    expect(out.rows[0].cost).toBe(5000);
    expect(out.rows[0].market_value).toBeNull();
    expect(out.total_pnl).toBe(0);
  });
});

describe("quote cache (offline fallback)", () => {
  beforeEach(() => { installStorage(); });

  it("remembers every symbol in a response and serves any later subset", async () => {
    // The URL cache misses whenever the symbol combination changes; this one
    // must not.
    const { rememberQuotes, cachedQuotes } = await import("../quoteCache.js");
    rememberQuotes([
      { symbol: "NVDA", price: 213.9, change: 1.2, change_pct: 0.5, name: "NVIDIA" },
      { symbol: "AAPL", price: 332.41, change: -1.7, change_pct: -0.5, name: "Apple" },
    ]);
    const { quotes } = cachedQuotes(["AAPL"]);        // different combination
    expect(quotes).toHaveLength(1);
    expect(quotes[0].price).toBe(332.41);
    expect(quotes[0]._stale).toBe(true);
  });

  it("skips not_found and priceless entries", async () => {
    const { rememberQuotes, cachedQuotes } = await import("../quoteCache.js");
    rememberQuotes([
      { symbol: "GOOD", price: 10 },
      { symbol: "BAD", price: 0, not_found: true },
    ]);
    expect(cachedQuotes(["GOOD", "BAD"]).quotes.map((q) => q.symbol)).toEqual(["GOOD"]);
  });

  it("reports the age of the OLDEST entry used", async () => {
    const { rememberQuotes, cachedQuotes } = await import("../quoteCache.js");
    rememberQuotes([{ symbol: "A", price: 1 }]);
    const { cachedAt } = cachedQuotes(["A"]);
    expect(cachedAt).toBeInstanceOf(Date);
    expect(Date.now() - cachedAt.getTime()).toBeLessThan(5000);
  });

  it("drops entries older than the max age", async () => {
    const { cachedQuotes, MAX_AGE_MS } = await import("../quoteCache.js");
    globalThis.localStorage.setItem("sae:quote_cache", JSON.stringify({
      OLD: { symbol: "OLD", price: 5, at: Date.now() - MAX_AGE_MS - 1000 },
    }));
    expect(cachedQuotes(["OLD"]).quotes).toHaveLength(0);
  });

  it("is case-insensitive on lookup", async () => {
    const { rememberQuotes, cachedQuotes } = await import("../quoteCache.js");
    rememberQuotes([{ symbol: "NVDA", price: 213.9 }]);
    expect(cachedQuotes(["nvda"]).quotes).toHaveLength(1);
  });

  it("survives corrupt storage", async () => {
    installStorage({ "sae:quote_cache": "not json" });
    const { cachedQuotes } = await import("../quoteCache.js");
    expect(cachedQuotes(["A"]).quotes).toEqual([]);
  });
});

describe("live stream symbol mapping (crypto)", () => {
  it("subscribes to BOTH exchanges for a USD coin", async () => {
    // Coinbase is a genuine USD pair so it matches the app's basis, but only
    // the Binance format appears in Finnhub's published examples. Neither is
    // guaranteed, so subscribe to both rather than betting on one.
    const { streamSymbolsFor } = await import("../useRealtime.js");
    expect(streamSymbolsFor("BTC-USD")).toEqual([
      "COINBASE:BTC-USD", "BINANCE:BTCUSDT",
    ]);
    expect(streamSymbolsFor("ETH-USD")).toEqual([
      "COINBASE:ETH-USD", "BINANCE:ETHUSDT",
    ]);
  });

  it("only uses Coinbase for a non-USD quote currency", async () => {
    // There is no BTCEUR Tether pair to fall back to.
    const { streamSymbolsFor } = await import("../useRealtime.js");
    expect(streamSymbolsFor("BTC-EUR")).toEqual(["COINBASE:BTC-EUR"]);
  });

  it("leaves equities, ETFs and indices alone", async () => {
    const { streamSymbolsFor } = await import("../useRealtime.js");
    for (const s of ["AAPL", "SPY", "^GSPC", "EURUSD=X"]) {
      expect(streamSymbolsFor(s)).toEqual([s]);
    }
  });

  it("maps BOTH exchanges back to the same app ticker", async () => {
    // A Tether tick must update the BTC-USD row, not invent a BTCUSDT one.
    const { fromStreamSymbol } = await import("../useRealtime.js");
    expect(fromStreamSymbol("COINBASE:BTC-USD")).toBe("BTC-USD");
    expect(fromStreamSymbol("BINANCE:BTCUSDT")).toBe("BTC-USD");
    expect(fromStreamSymbol("BINANCE:ETHUSDT")).toBe("ETH-USD");
    expect(fromStreamSymbol("AAPL")).toBe("AAPL");
  });

  it("round-trips the preferred symbol", async () => {
    const { toStreamSymbol, fromStreamSymbol } = await import("../useRealtime.js");
    for (const s of ["BTC-USD", "ETH-USD", "AAPL", "^GSPC"]) {
      expect(fromStreamSymbol(toStreamSymbol(s))).toBe(s);
    }
  });

  it("prefers the real USD pair over the Tether proxy", async () => {
    // USDT tracks USD to about a tenth of a percent — on an $80k coin that is
    // a visible discrepancy against the price shown everywhere else.
    const { preferTick } = await import("../useRealtime.js");
    expect(preferTick({ source: "COINBASE" }, { source: "BINANCE" })).toBe(false);
    expect(preferTick({ source: "BINANCE" }, { source: "COINBASE" })).toBe(true);
    expect(preferTick(undefined, { source: "BINANCE" })).toBe(true);
    expect(preferTick({ source: "COINBASE" }, { source: "COINBASE" })).toBe(true);
  });
});

describe("runtime: where the API lives", () => {
  const realWindow = globalThis.window;

  afterEach(() => { globalThis.window = realWindow; });

  async function runtimeWith(win) {
    globalThis.window = win;
    // Fresh import per case: the module reads the environment at call time,
    // but platform detection is cheap and this keeps cases independent.
    const mod = await import("../runtime.js?t=" + Math.random());
    return mod;
  }

  it("uses relative paths on the web, keeping calls same-origin", async () => {
    const r = await runtimeWith({ location: { protocol: "https:", hostname: "x.com" } });
    expect(r.platform()).toBe("web");
    expect(r.isPackaged()).toBe(false);
    expect(r.apiUrl("/api/health")).toBe("/api/health");
  });

  it("detects the Capacitor shells", async () => {
    for (const p of ["ios", "android"]) {
      const r = await runtimeWith({
        Capacitor: { getPlatform: () => p },
        location: { protocol: "https:", hostname: "localhost" },
      });
      expect(r.platform()).toBe(p);
      expect(r.isPackaged()).toBe(true);
    }
  });

  it("detects the Electron shell via the preload flag", async () => {
    const r = await runtimeWith({
      __SAE_DESKTOP__: true, location: { protocol: "file:", hostname: "" },
    });
    expect(r.platform()).toBe("desktop");
    expect(r.platformLabel()).toBe("Desktop app");
  });

  it("gives packaged builds an ABSOLUTE api url", async () => {
    // A relative path inside a file:// bundle resolves to the bundle itself and
    // fetches nothing — this is the whole reason the module exists.
    const r = await runtimeWith({
      __SAE_DESKTOP__: true, location: { protocol: "file:", hostname: "" },
    });
    const url = r.apiUrl("/api/health");
    expect(url.startsWith("http")).toBe(true);
    expect(url.endsWith("/api/health")).toBe(true);
  });

  it("never registers a service worker in a packaged shell", async () => {
    // The native shell already bundles the assets; a worker would only add a
    // staler second copy, and cannot register on file:// at all.
    const desktop = await runtimeWith({
      __SAE_DESKTOP__: true, location: { protocol: "file:", hostname: "" },
    });
    expect(desktop.serviceWorkerUseful()).toBe(false);

    const web = await runtimeWith({ location: { protocol: "https:", hostname: "x.com" } });
    expect(web.serviceWorkerUseful()).toBe(true);
  });

  it("does not register a worker over plain http on a remote host", async () => {
    const r = await runtimeWith({ location: { protocol: "http:", hostname: "example.com" } });
    expect(r.serviceWorkerUseful()).toBe(false);
  });
});
