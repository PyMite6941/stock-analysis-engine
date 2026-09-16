import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  ago, clearRecents, loadRecents, MAX_RECENTS, recordSearch, removeRecent,
} from "../recents.js";

// Minimal localStorage stand-in — these helpers exist to keep browser storage
// small and bounded, so the cap and the byte size are what's worth testing.
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

describe("recents", () => {
  beforeEach(() => { installStorage(); });

  it("records a search, newest first", () => {
    recordSearch("AAPL");
    recordSearch("MSFT");
    expect(loadRecents().map((r) => r.symbol)).toEqual(["MSFT", "AAPL"]);
  });

  it("uppercases and trims", () => {
    recordSearch("  nvda  ");
    expect(loadRecents()[0].symbol).toBe("NVDA");
  });

  it("splits a comma-separated search into separate entries", () => {
    recordSearch("AAPL, MSFT,NVDA");
    expect(loadRecents().map((r) => r.symbol)).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("moves a repeat search to the front instead of duplicating", () => {
    recordSearch("AAPL");
    recordSearch("MSFT");
    recordSearch("AAPL");
    const syms = loadRecents().map((r) => r.symbol);
    expect(syms).toEqual(["AAPL", "MSFT"]);
    expect(syms.filter((s) => s === "AAPL")).toHaveLength(1);
  });

  it("caps the list so storage cannot grow unbounded", () => {
    for (let i = 0; i < MAX_RECENTS + 15; i++) recordSearch(`SYM${i}`);
    const list = loadRecents();
    expect(list).toHaveLength(MAX_RECENTS);
    // Newest kept, oldest dropped.
    expect(list[0].symbol).toBe(`SYM${MAX_RECENTS + 14}`);
  });

  it("keeps the stored payload tiny even when full", () => {
    for (let i = 0; i < MAX_RECENTS + 20; i++) recordSearch(`TICKER${i}`);
    const raw = globalThis.localStorage.getItem("sae:recents");
    // Well under 1 KB — the whole point of capping it.
    expect(raw.length).toBeLessThan(1024);
  });

  it("stores only symbol and timestamp, nothing else", () => {
    recordSearch("AAPL");
    const raw = JSON.parse(globalThis.localStorage.getItem("sae:recents"));
    expect(Object.keys(raw[0]).sort()).toEqual(["at", "symbol"]);
  });

  it("removes a single entry", () => {
    recordSearch(["AAPL", "MSFT"]);
    removeRecent("aapl");
    expect(loadRecents().map((r) => r.symbol)).toEqual(["MSFT"]);
  });

  it("clears everything", () => {
    recordSearch(["AAPL", "MSFT"]);
    clearRecents();
    expect(loadRecents()).toEqual([]);
  });

  it("ignores empty input", () => {
    recordSearch("AAPL");
    recordSearch("   ");
    recordSearch([]);
    expect(loadRecents()).toHaveLength(1);
  });

  it("survives corrupt storage", () => {
    installStorage({ "sae:recents": "{not json" });
    expect(loadRecents()).toEqual([]);
  });

  it("survives a non-array payload", () => {
    installStorage({ "sae:recents": '{"symbol":"AAPL"}' });
    expect(loadRecents()).toEqual([]);
  });

  it("drops malformed entries but keeps good ones", () => {
    installStorage({
      "sae:recents": JSON.stringify([{ symbol: "AAPL", at: 1 }, { nope: true }, null]),
    });
    expect(loadRecents().map((r) => r.symbol)).toEqual(["AAPL"]);
  });
});

describe("ago", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  const at = (ms) => Date.now() - ms;

  it("says just now for very recent", () => {
    expect(ago(at(30 * 1000))).toBe("just now");
  });
  it("formats minutes", () => {
    expect(ago(at(10 * 60 * 1000))).toBe("10m ago");
  });
  it("formats hours", () => {
    expect(ago(at(5 * 3600 * 1000))).toBe("5h ago");
  });
  it("formats days", () => {
    expect(ago(at(3 * 86400 * 1000))).toBe("3d ago");
  });
  it("formats months", () => {
    expect(ago(at(70 * 86400 * 1000))).toBe("2mo ago");
  });
  it("returns empty for a missing timestamp", () => {
    expect(ago(0)).toBe("");
    expect(ago(undefined)).toBe("");
  });
});
