import { describe, it, expect } from "vitest";
import { rankMovers } from "../movers.js";
import { breakEvenWinRate, sizePosition } from "../tradeMath.js";
import { buy, newAccount, sell, valueAccount } from "../paper.js";
import { duration, nextSessionChange } from "../market.js";

describe("rankMovers", () => {
  const q = (symbol, change_pct) => ({ symbol, change_pct });

  it("puts the biggest % rise first and the biggest % fall first", () => {
    const r = rankMovers([q("A", 1), q("B", 5), q("C", -3), q("D", -8), q("E", 0)], 5);
    expect(r.gainers.map((x) => x.symbol)).toEqual(["B", "A"]);
    expect(r.losers.map((x) => x.symbol)).toEqual(["D", "C"]);
  });

  it("skips unknown tickers and missing numbers", () => {
    const r = rankMovers([{ symbol: "X", not_found: true, change_pct: 50 }, q("Y", null)]);
    expect(r.gainers).toEqual([]);
  });

  it("keeps only the top n", () => {
    const r = rankMovers([1, 2, 3, 4].map((n) => q(`S${n}`, n)), 2);
    expect(r.gainers.map((x) => x.symbol)).toEqual(["S4", "S3"]);
  });
});

describe("sizePosition", () => {
  it("sizes a long so a stop-out loses exactly the risk budget", () => {
    // $10,000 account, risk 1% = $100. Entry 50, stop 48 = $2 a share -> 50 shares.
    const p = sizePosition({ account: 10000, riskPct: 1, entry: 50, stop: 48, target: 56 });
    expect(p.side).toBe("long");
    expect(p.shares).toBe(50);
    expect(p.maxLoss).toBe(100);
    expect(p.rewardRisk).toBe(3);
    expect(p.reward).toBe(300);
  });

  it("works for shorts (stop above entry)", () => {
    const p = sizePosition({ account: 10000, riskPct: 1, entry: 50, stop: 52, target: 46 });
    expect(p.side).toBe("short");
    expect(p.rewardRisk).toBe(2);
  });

  it("never buys more than the account can afford", () => {
    // Risk says 1000 shares, but $10,000 buys only 200 at $50.
    const p = sizePosition({ account: 10000, riskPct: 1, entry: 50, stop: 49.9 });
    expect(p.shares).toBe(200);
    expect(p.cappedByCash).toBe(true);
  });

  it("flags a target on the wrong side of the entry", () => {
    expect(sizePosition({ account: 1000, riskPct: 1, entry: 10, stop: 9, target: 8 })
      .targetOnWrongSide).toBe(true);
  });

  it("refuses impossible inputs", () => {
    expect(sizePosition({ account: 1000, riskPct: 1, entry: 10, stop: 10 })).toBeNull();
    expect(sizePosition({ account: 0, riskPct: 1, entry: 10, stop: 9 })).toBeNull();
  });

  it("break-even win rate: at 2:1 you need to win 1 in 3", () => {
    expect(breakEvenWinRate(2)).toBeCloseTo(33.33, 1);
    expect(breakEvenWinRate(0)).toBeNull();
  });
});

describe("paper trading", () => {
  it("buys, averages the cost, and sells at a profit", () => {
    let a = newAccount(1000);
    a = buy(a, "AAPL", 2, 100);
    a = buy(a, "AAPL", 2, 200);          // average cost is now 150
    expect(a.cash).toBe(400);
    const { account, profit } = sell(a, "AAPL", 2, 175);
    expect(profit).toBe(50);             // (175 - 150) * 2
    expect(account.holdings.AAPL).toEqual({ shares: 2, cost: 300 });
    expect(account.cash).toBe(750);
  });

  it("won't spend money you don't have or sell shares you don't own", () => {
    const a = newAccount(100);
    expect(() => buy(a, "AAPL", 1, 101)).toThrow("only have");
    expect(() => sell(a, "AAPL", 1, 50)).toThrow("only own");
  });

  it("removes a holding once it's all sold", () => {
    const a = buy(newAccount(1000), "KO", 3, 60);
    expect(sell(a, "KO", 3, 60).account.holdings.KO).toBeUndefined();
  });

  it("values the account at live prices", () => {
    const a = buy(newAccount(1000), "KO", 10, 50);   // $500 cash + 10 shares
    const v = valueAccount(a, { KO: 60 });
    expect(v.total).toBe(1100);
    expect(v.gainPct).toBeCloseTo(10);
  });
});

describe("nextSessionChange", () => {
  // Wednesday 2026-09-23. New York is UTC-4 in September.
  const ny = (hhmm, day = "2026-09-23") => new Date(`${day}T${hhmm}:00-04:00`);

  it("counts down to the close during the session", () => {
    const s = nextSessionChange(ny("15:15"));
    expect(s.next).toBe("Closes");
    expect(s.until).toBe(45);
  });

  it("counts down to the open in pre-market", () => {
    expect(nextSessionChange(ny("08:00")).text).toBe("Opens in 1h 30m");
  });

  it("after the close, points at tomorrow's open", () => {
    expect(nextSessionChange(ny("17:00")).until).toBe(16 * 60 + 30);
  });

  it("on Friday evening, skips the weekend", () => {
    // Fri 17:00 -> Mon 09:30 is 2 days 16.5 hours.
    expect(nextSessionChange(ny("17:00", "2026-09-25")).until).toBe(2 * 1440 + 16 * 60 + 30);
  });

  it("formats durations", () => {
    expect(duration(45)).toBe("45m");
    expect(duration(135)).toBe("2h 15m");
    expect(duration(2900)).toBe("2d 0h");
  });
});
