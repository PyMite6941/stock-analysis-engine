import { describe, it, expect } from "vitest";
import { big, money, num, pct, safeUrl } from "../format.js";

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

describe("money", () => {
  it("always shows both decimal places", () => {
    // `num` sets only a maximum, so 2255.1 came out as "2,255.1" — which reads
    // as a typo when it is meant to be a dollar amount.
    expect(money(2255.1)).toBe("$2,255.10");
    expect(money(500)).toBe("$500.00");
  });

  it("puts the minus before the dollar sign", () => {
    expect(money(-42.5)).toBe("−$42.50");
  });

  it("adds a plus only when asked", () => {
    expect(money(42.5)).toBe("$42.50");
    expect(money(42.5, { sign: true })).toBe("+$42.50");
    expect(money(-42.5, { sign: true })).toBe("−$42.50");
  });

  it("does not sign zero as positive when asked for a sign", () => {
    expect(money(0, { sign: true })).toBe("+$0.00");
  });

  it("handles nothing gracefully", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(NaN)).toBe("—");
  });
});

describe("safeUrl", () => {
  it("keeps ordinary web links", () => {
    expect(safeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("blocks links that would run code", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl(" JavaScript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects junk", () => {
    expect(safeUrl("")).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
  });
});
