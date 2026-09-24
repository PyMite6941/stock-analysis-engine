import { describe, it, expect } from "vitest";
import {
  barsFor, cleanKey, finnhubToQuote, isCrypto, toFinnhubSymbol, toTwelveSymbol,
  twelveToCandles,
} from "../direct.js";

describe("cleanKey", () => {
  it("accepts a normal API key", () => {
    expect(cleanKey("  abc123DEF456xyz  ")).toBe("abc123DEF456xyz");
  });

  it("rejects anything that could break out of a URL", () => {
    expect(cleanKey("abc123&symbol=EVIL")).toBe("");
    expect(cleanKey("abc 123 def 456")).toBe("");
    expect(cleanKey("short")).toBe("");
    expect(cleanKey(null)).toBe("");
  });
});

describe("symbol translation", () => {
  it("spots crypto pairs", () => {
    expect(isCrypto("BTC-USD")).toBe(true);
    expect(isCrypto("BRK-B")).toBe(false);
    expect(isCrypto("AAPL")).toBe(false);
  });

  it("speaks each provider's dialect", () => {
    expect(toTwelveSymbol("BTC-USD")).toBe("BTC/USD");
    expect(toTwelveSymbol("BRK-B")).toBe("BRK.B");
    expect(toFinnhubSymbol("BRK-B")).toBe("BRK.B");
    expect(toTwelveSymbol("AAPL")).toBe("AAPL");
  });
});

describe("finnhubToQuote", () => {
  it("maps Finnhub's short field names onto the app's quote shape", () => {
    const q = finnhubToQuote("AAPL", { c: 110, d: 10, dp: 10, o: 101, h: 111, l: 99, pc: 100 },
      "Apple Inc");
    expect(q).toMatchObject({
      symbol: "AAPL", name: "Apple Inc", price: 110, change: 10, change_pct: 10,
      not_found: false, prev_close: 100,
    });
  });

  it("treats Finnhub's all-zeros reply as 'no such ticker'", () => {
    expect(finnhubToQuote("ZZZZ", { c: 0, d: null, dp: null, pc: 0 }).not_found).toBe(true);
  });
});

describe("barsFor", () => {
  it("asks for one bar per trading day on daily charts", () => {
    expect(barsFor("1y", "1d")).toEqual({ interval: "1day", outputsize: 252 });
  });

  it("asks for a day's worth of 5-minute bars", () => {
    expect(barsFor("1d", "5m")).toEqual({ interval: "5min", outputsize: 78 });
  });

  it("never exceeds the provider's 5000-bar cap", () => {
    expect(barsFor("max", "1d").outputsize).toBe(5000);
  });
});

describe("twelveToCandles", () => {
  const res = {
    status: "ok",
    // Twelve Data sends the newest row first, and every number as a string.
    values: [
      { datetime: "2026-09-23 14:35:00", open: "3", high: "4", low: "2", close: "3.5", volume: "10" },
      { datetime: "2026-09-23 14:30:00", open: "1", high: "2", low: "1", close: "2", volume: "20" },
    ],
  };

  it("puts rows oldest-first and turns strings into numbers", () => {
    const c = twelveToCandles("AAPL", res);
    expect(c.dates).toEqual(["2026-09-23 14:30", "2026-09-23 14:35"]);
    expect(c.close).toEqual([2, 3.5]);
    expect(c.volume).toEqual([20, 10]);
    expect(c.indicators.rsi).toHaveLength(2);
  });

  it("turns a provider error into a readable error", () => {
    expect(() => twelveToCandles("ZZZZ", { status: "error", message: "symbol not found" }))
      .toThrow("symbol not found");
  });
});
