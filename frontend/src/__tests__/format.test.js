import { describe, it, expect } from "vitest";
import { num, big, pct } from "../format.js";

describe("num", () => {
  it("formats numbers with commas", () => {
    expect(num(1234)).toBe("1,234");
  });

  it("returns em dash for null", () => {
    expect(num(null)).toBe("—");
  });

  it("returns em dash for undefined", () => {
    expect(num(undefined)).toBe("—");
  });

  it("returns em dash for NaN", () => {
    expect(num(NaN)).toBe("—");
  });

  it("respects max fraction digits", () => {
    expect(num(1.23456, 1)).toBe("1.2");
  });
});

describe("big", () => {
  it("formats trillions", () => {
    expect(big(2_500_000_000_000)).toBe("2.50T");
  });

  it("formats billions", () => {
    expect(big(3_400_000_000)).toBe("3.40B");
  });

  it("formats millions", () => {
    expect(big(5_600_000)).toBe("5.60M");
  });

  it("formats thousands", () => {
    expect(big(7_800)).toBe("7.80K");
  });

  it("returns em dash for null", () => {
    expect(big(null)).toBe("—");
  });
});

describe("pct", () => {
  it("formats percentage", () => {
    expect(pct(15.32)).toBe("15.32%");
  });

  it("returns em dash for null", () => {
    expect(pct(null)).toBe("—");
  });
});
