import { describe, it, expect } from "vitest";
import { bollinger, computeAll, ema, macd, rsi, sma } from "../indicators.js";
// Produced by core/indicators.py (compute_all) on the same prices. If this test
// fails, the browser and the server would draw different charts.
import fixture from "./indicators.fixture.json";

function expectSeriesClose(actual, expected) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => {
    if (expected[i] === null) expect(v).toBeNull();
    else expect(v).toBeCloseTo(expected[i], 3);
  });
}

describe("computeAll matches the Python implementation", () => {
  const got = computeAll(fixture.close);
  for (const key of Object.keys(fixture.expected)) {
    it(key, () => expectSeriesClose(got[key], fixture.expected[key]));
  }
});

describe("small hand-checked cases", () => {
  it("sma averages the last N values", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });

  it("ema seeds with the sma, then weights recent values more", () => {
    // k = 2/(2+1) = 2/3. Seed (1+2)/2 = 1.5, then 3*2/3 + 1.5/3 = 2.5
    expect(ema([1, 2, 3], 2)).toEqual([null, 1.5, 2.5]);
  });

  it("rsi is 100 when the price only ever went up", () => {
    const up = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(rsi(up, 14).at(-1)).toBe(100);
  });

  it("keeps every output the same length as the input", () => {
    const short = [1, 2, 3];
    expect(sma(short, 5)).toEqual([null, null, null]);
    expect(macd(short).macd).toHaveLength(3);
    expect(bollinger(short).upper).toHaveLength(3);
  });

  it("bollinger bands are the average ± 2 standard deviations", () => {
    const { mid, upper, lower } = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8);
    // Classic example: mean 5, population sd 2.
    expect(mid[7]).toBe(5);
    expect(upper[7]).toBe(9);
    expect(lower[7]).toBe(1);
  });
});
