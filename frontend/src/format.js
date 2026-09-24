// Shared number formatting helpers.

export function num(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

// Money always shows both decimal places. `num` sets only a MAXIMUM, so a
// value like 2255.1 renders as "$2,255.1", which reads as a typo rather than
// as $2,255.10. Share counts still use `num`, where a trailing "10.0000" would
// be the wrong kind of precise.
export function money(n, { sign = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  const body = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const lead = v < 0 ? "−" : sign ? "+" : "";
  return `${lead}$${body}`;
}

export function big(n) {
  if (n === null || n === undefined) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return num(n, 0);
}

export function pct(n, d = 2) {
  if (n === null || n === undefined) return "—";
  return `${num(n, d)}%`;
}
