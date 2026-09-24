// Analysis maths over a price series, in the browser.
//
// A port of core/metrics.py — the numbers in the summary bar and quote table.
// Used in direct mode (no backend); src/__tests__/metrics.test.js checks it
// against the Python output so the two never quietly disagree.

function pctReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]) out.push(closes[i] / closes[i - 1] - 1);
  }
  return out;
}

/** How much the price changed from the first close to the last, in %. */
export function totalReturnPct(closes) {
  if (closes.length < 2 || !closes[0]) return 0;
  return (closes[closes.length - 1] / closes[0] - 1) * 100;
}

/**
 * How jumpy the price is: the standard deviation of daily returns, scaled up
 * to a year. There are about 252 trading days a year, and randomness grows
 * with the square root of time — hence the √252.
 */
export function annualizedVolatilityPct(closes) {
  const rets = pctReturns(closes);
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** The worst fall from a high point to a later low, as a negative %. */
export function maxDrawdownPct(closes) {
  let peak = -Infinity;
  let worst = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    if (peak) worst = Math.min(worst, c / peak - 1);
  }
  return worst * 100;
}

function movingAverage(closes, window) {
  if (closes.length < window) return null;
  let s = 0;
  for (let i = closes.length - window; i < closes.length; i++) s += closes[i];
  return s / window;
}

// Python's round() and JS's Math.round() treat exact .5 ties differently, but
// on real prices ties are vanishingly rare and only move the last digit.
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

function trendSignal(last, ma50, ma200) {
  if (last == null || ma50 == null) return "insufficient-data";
  if (ma200 != null) {
    if (last > ma50 && ma50 > ma200) return "strong-uptrend";
    if (last < ma50 && ma50 < ma200) return "strong-downtrend";
  }
  return last > ma50 ? "uptrend" : "downtrend";
}

/** Per-symbol stat block, same keys as metrics.analyze_history. */
export function analyzeHistory(symbol, closes) {
  const ma50 = movingAverage(closes, 50);
  const ma200 = movingAverage(closes, 200);
  const last = closes.length ? closes[closes.length - 1] : null;
  return {
    symbol,
    points: closes.length,
    last,
    total_return_pct: round(totalReturnPct(closes), 2),
    annualized_volatility_pct: round(annualizedVolatilityPct(closes), 2),
    max_drawdown_pct: round(maxDrawdownPct(closes), 2),
    ma50: ma50 ? round(ma50, 4) : null,
    ma200: ma200 ? round(ma200, 4) : null,
    trend: trendSignal(last, ma50, ma200),
  };
}

function argExtreme(analyses, key, pickMax) {
  const c = analyses.filter((a) => (a.points || 0) > 1);
  if (!c.length) return null;
  // First one wins on a tie, like Python's max()/min().
  return c.reduce((best, a) =>
    (pickMax ? a[key] > best[key] : a[key] < best[key]) ? a : best).symbol;
}

const avg = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null);

/** The headline numbers for the summary bar, same keys as portfolio_summary. */
export function portfolioSummary(quotes, analyses) {
  const ok = analyses.filter((a) => (a.points || 0) > 1);
  const gainers = quotes.filter((q) => q.change_pct > 0).length;
  return {
    n_symbols: quotes.length,
    gainers,
    losers: quotes.length - gainers,
    avg_pe: avg(quotes.map((q) => q.pe).filter(Boolean)),
    avg_total_return_pct: avg(ok.map((a) => a.total_return_pct)),
    avg_volatility_pct: avg(ok.map((a) => a.annualized_volatility_pct)),
    most_volatile: argExtreme(analyses, "annualized_volatility_pct", true),
    best_performer: argExtreme(analyses, "total_return_pct", true),
    worst_performer: argExtreme(analyses, "total_return_pct", false),
  };
}
