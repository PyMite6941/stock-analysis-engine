import { describe, it, expect } from "vitest";
import { analyzeHistory, maxDrawdownPct, portfolioSummary, totalReturnPct } from "../metrics.js";
// Produced by core/metrics.py on the same prices.
import fixture from "./metrics.fixture.json";

describe("metrics match the Python implementation", () => {
  const got = Object.entries(fixture.series).map(([s, c]) => analyzeHistory(s, c));

  fixture.analyses.forEach((expected, i) => {
    it(`analyzeHistory(${expected.symbol})`, () => {
      expect(got[i]).toEqual(expected);
    });
  });

  it("portfolioSummary", () => {
    expect(portfolioSummary(fixture.quotes, got)).toEqual(fixture.summary);
  });
});

describe("hand-checked cases", () => {
  it("total return from first to last close", () => {
    expect(totalReturnPct([100, 150])).toBeCloseTo(50);
  });

  it("drawdown is the worst fall from a high", () => {
    // Peak 200, later low 50: a 75% fall, even though it recovered after.
    expect(maxDrawdownPct([100, 200, 50, 300])).toBeCloseTo(-75);
  });
});
