import { describe, it, expect, beforeEach } from "vitest";
import {
  addPosition, csvToPositions, loadPositions, markToMarket, mergePositions,
  parseCsv, positionsToCsv, removePosition, replacePositions, savePositions,
  symbolsOf, updatePosition,
} from "../positions.js";

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

describe("positions store", () => {
  beforeEach(() => { installStorage(); });

  it("adds a position and assigns an id", () => {
    const list = addPosition([], { symbol: "nvda", shares: "400", cost_basis: "178.5" });
    expect(list).toHaveLength(1);
    expect(list[0].symbol).toBe("NVDA");
    expect(list[0].shares).toBe(400);
    expect(list[0].cost_basis).toBe(178.5);
    expect(list[0].id).toBeTruthy();
  });

  it("rejects an entry missing numbers", () => {
    expect(addPosition([], { symbol: "NVDA" })).toHaveLength(0);
    expect(addPosition([], { shares: 1, cost_basis: 1 })).toHaveLength(0);
  });

  it("persists across a reload", () => {
    addPosition([], { symbol: "AAPL", shares: 10, cost_basis: 400 });
    expect(loadPositions().map((p) => p.symbol)).toEqual(["AAPL"]);
  });

  it("updates a position without changing its id", () => {
    const list = addPosition([], { symbol: "AAPL", shares: 10, cost_basis: 400 });
    const id = list[0].id;
    const next = updatePosition(list, id, { shares: 20 });
    expect(next[0].id).toBe(id);
    expect(next[0].shares).toBe(20);
  });

  it("removes a position", () => {
    const list = addPosition([], { symbol: "AAPL", shares: 10, cost_basis: 400 });
    expect(removePosition(list, list[0].id)).toHaveLength(0);
  });

  it("merges imports rather than replacing hand-entered lots", () => {
    const list = addPosition([], { symbol: "AAPL", shares: 10, cost_basis: 400 });
    const merged = mergePositions(list, [{ symbol: "MSFT", shares: 5, cost_basis: 400 }]);
    expect(merged.map((p) => p.symbol).sort()).toEqual(["AAPL", "MSFT"]);
  });

  it("replacePositions overwrites the list", () => {
    const list = addPosition([], { symbol: "AAPL", shares: 10, cost_basis: 400 });
    expect(replacePositions([{ symbol: "X", shares: 1, cost_basis: 1 }])).toHaveLength(1);
    expect(loadPositions()[0].symbol).toBe("X");
  });

  it("symbolsOf de-duplicates", () => {
    expect(symbolsOf([{ symbol: "A" }, { symbol: "A" }, { symbol: "B" }]))
      .toEqual(["A", "B"]);
  });

  it("survives corrupt storage", () => {
    installStorage({ "sae:positions": "not json" });
    expect(loadPositions()).toEqual([]);
  });

  it("does not throw when storage is unavailable", () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(() => loadPositions()).not.toThrow();
    expect(() => savePositions([])).not.toThrow();
  });
});

describe("markToMarket", () => {
  it("computes P/L from cost basis", () => {
    const out = markToMarket(
      [{ symbol: "NVDA", shares: 400, cost_basis: 178.5 }],
      { NVDA: 212.17 });
    expect(out.total_cost).toBeCloseTo(71400, 2);
    expect(out.total_value).toBeCloseTo(84868, 2);
    expect(out.total_pnl).toBeCloseTo(13468, 2);
    expect(out.total_pnl_pct).toBeCloseTo(18.86, 2);
  });

  it("shows an unpriced lot's own cost but keeps it out of the TOTALS", () => {
    // This test previously asserted total_cost === 50, which locked in a bug:
    // counting an unpriced lot's cost while its value stayed 0 reported it as
    // a 100% loss. The row still shows what it cost; the totals only cover
    // lots that could actually be marked to market.
    const out = markToMarket(
      [{ symbol: "NOPE", shares: 5, cost_basis: 10 }], {});
    expect(out.rows[0].cost).toBe(50);
    expect(out.rows[0].market_value).toBeNull();
    expect(out.total_cost).toBe(0);
    expect(out.total_value).toBe(0);
    expect(out.total_pnl).toBe(0);
  });
});

describe("CSV round trip", () => {
  beforeEach(() => { installStorage(); });

  it("parses quoted fields containing commas", () => {
    const rows = parseCsv('a,b\n"x,y",z\n');
    expect(rows[1]).toEqual(["x,y", "z"]);
  });

  it("parses escaped double quotes", () => {
    const rows = parseCsv('a\n"say ""hi"""\n');
    expect(rows[1][0]).toBe('say "hi"');
  });

  it("round-trips a position list", () => {
    const list = addPosition([], {
      symbol: "NVDA", shares: 400, cost_basis: 178.5,
      opened: "2026-09-01", note: "post-earnings, big size",
    });
    const back = csvToPositions(positionsToCsv(list));
    expect(back[0]).toMatchObject({
      symbol: "NVDA", shares: 400, cost_basis: 178.5, opened: "2026-09-01",
    });
    expect(back[0].note).toBe("post-earnings, big size");
  });

  it("accepts broker header spellings", () => {
    const back = csvToPositions("Ticker,Qty,Average Cost\nmsft,25,412.30\n");
    expect(back[0]).toMatchObject({ symbol: "MSFT", shares: 25, cost_basis: 412.3 });
  });

  it("strips currency formatting", () => {
    const back = csvToPositions('Symbol,Shares,Cost Basis\nIBM,"1,000","$1,234.50"\n');
    expect(back[0].shares).toBe(1000);
    expect(back[0].cost_basis).toBeCloseTo(1234.5, 2);
  });

  it("prefers cost_basis over a price column when both exist", () => {
    // Our own export carries both; price is the CURRENT mark, not what was paid.
    const back = csvToPositions(
      "symbol,shares,cost_basis,price\nNVDA,400,178.50,212.17\n");
    expect(back[0].cost_basis).toBe(178.5);
  });

  it("throws a clear error when there is no symbol column", () => {
    expect(() => csvToPositions("a,b\n1,2\n")).toThrow(/symbol/i);
  });

  it("drops rows missing required numbers", () => {
    const back = csvToPositions(
      "Symbol,Shares,Cost Basis\nAAPL,10,100\nBAD,,\n");
    expect(back.map((r) => r.symbol)).toEqual(["AAPL"]);
  });
});
