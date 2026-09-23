import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_MS, ago, allContinuous, looksContinuous, marketStatus,
  newYorkTime, priceFreshness,
} from "../market.js";

// Dates are built in UTC and interpreted in New York, which is the whole point
// — the app runs in Bangkok and the market it reports on does not.
const utc = (iso) => new Date(iso);

describe("newYorkTime", () => {
  it("converts UTC to New York wall clock", () => {
    // 14:30 UTC in January = 09:30 EST.
    const t = newYorkTime(utc("2026-01-15T14:30:00Z"));
    expect(t.minutes).toBe(9 * 60 + 30);
    expect(t.weekday).toBe("Thu");
  });

  it("follows daylight saving rather than a fixed offset", () => {
    // Same UTC hour in July is 10:30 EDT, an hour later than in January.
    const summer = newYorkTime(utc("2026-07-15T14:30:00Z"));
    expect(summer.minutes).toBe(10 * 60 + 30);
  });

  it("handles midnight without rendering it as hour 24", () => {
    const t = newYorkTime(utc("2026-01-15T05:00:00Z"));   // 00:00 EST
    expect(t.minutes).toBe(0);
  });
});

describe("marketStatus", () => {
  it("is open during the regular session", () => {
    expect(marketStatus(utc("2026-01-15T15:00:00Z")).state).toBe("open");
  });

  it("closes at 16:00 ET, not a minute later", () => {
    expect(marketStatus(utc("2026-01-15T20:59:00Z")).state).toBe("open");
    expect(marketStatus(utc("2026-01-15T21:00:00Z")).state).toBe("afterhours");
  });

  it("opens at 09:30 ET, not 09:29", () => {
    expect(marketStatus(utc("2026-01-15T14:29:00Z")).state).toBe("premarket");
    expect(marketStatus(utc("2026-01-15T14:30:00Z")).state).toBe("open");
  });

  it("knows the weekend", () => {
    const sat = marketStatus(utc("2026-01-17T15:00:00Z"));
    expect(sat.state).toBe("weekend");
    expect(sat.live).toBe(false);
  });

  it("is closed overnight", () => {
    expect(marketStatus(utc("2026-01-15T07:00:00Z")).state).toBe("closed");
  });

  it("treats a continuous market as always open", () => {
    const s = marketStatus(utc("2026-01-17T03:00:00Z"), { continuous: true });
    expect(s.state).toBe("open");
    expect(s.continuous).toBe(true);
  });
});

describe("ago", () => {
  it("describes an age, not a timestamp", () => {
    const now = 1_000_000_000;
    expect(ago(now - 2000, now)).toBe("just now");
    expect(ago(now - 40_000, now)).toBe("40s ago");
    expect(ago(now - 3 * 60_000, now)).toBe("3m ago");
    expect(ago(now - 2 * 3_600_000, now)).toBe("2h ago");
  });

  it("returns null with nothing to measure", () => {
    expect(ago(null)).toBeNull();
  });

  it("never reports a negative age from clock skew", () => {
    const now = 1_000_000_000;
    expect(ago(now + 5000, now)).toBe("just now");
  });
});

describe("priceFreshness", () => {
  const openNow = utc("2026-01-15T15:00:00Z").getTime();     // Thursday session
  const shutNow = utc("2026-01-15T07:00:00Z").getTime();     // overnight

  it("reports live when ticks are arriving", () => {
    const f = priceFreshness({ lastTick: openNow - 1000, lastPoll: null,
                               streaming: true, now: openNow });
    expect(f.stale).toBe(false);
    expect(f.source).toBe("stream");
    expect(f.text).toContain("Live");
  });

  it("goes stale when the session is open but nothing arrives", () => {
    const f = priceFreshness({ lastTick: openNow - STALE_AFTER_MS - 1000,
                               streaming: true, now: openNow });
    expect(f.stale).toBe(true);
    expect(f.text).toContain("not updating");
  });

  it("does NOT call a price stale while the market is shut", () => {
    // The distinction that matters: an hour-old price at 2am is simply the
    // closing price, and warning about it would be noise.
    const f = priceFreshness({ lastPoll: shutNow - 60 * 60 * 1000,
                               now: shutNow });
    expect(f.stale).toBe(false);
    expect(f.text).toContain("Market closed");
  });

  it("holds crypto to the live standard at 3am", () => {
    const f = priceFreshness({ lastTick: shutNow - STALE_AFTER_MS - 1000,
                               continuous: true, streaming: true,
                               now: shutNow });
    expect(f.stale).toBe(true);
  });

  it("prefers the newer of a tick and a poll", () => {
    const f = priceFreshness({ lastTick: openNow - 50_000,
                               lastPoll: openNow - 1000, now: openNow });
    expect(f.source).toBe("poll");
    expect(f.at).toBe(openNow - 1000);
  });

  it("says it is waiting when nothing has arrived at all", () => {
    const f = priceFreshness({ now: openNow });
    expect(f.source).toBe("none");
    expect(f.age).toBeNull();
    expect(f.text).toContain("Waiting");
  });
});

describe("continuous symbols", () => {
  it("recognises crypto pairs", () => {
    expect(looksContinuous("BTC-USD")).toBe(true);
    expect(looksContinuous("eth-usd")).toBe(true);
    expect(looksContinuous("AAPL")).toBe(false);
  });

  it("only calls a watchlist continuous when every symbol is", () => {
    expect(allContinuous(["BTC-USD", "ETH-USD"])).toBe(true);
    expect(allContinuous(["BTC-USD", "AAPL"])).toBe(false);
    expect(allContinuous([])).toBe(false);
  });
});
