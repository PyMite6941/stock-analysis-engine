// Technical indicators, in the browser.
//
// A line-for-line port of core/indicators.py, so the app can draw RSI, MACD and
// friends without a backend. The rules are the same as the Python version:
//
//   Every function returns an array the SAME LENGTH as its input, with `null`
//   in the warm-up region where there isn't enough data yet. That keeps every
//   series lined up with the same dates, and the chart just skips the nulls.
//
// src/__tests__/indicators.test.js checks these against numbers produced by the
// Python code, so if either side changes, the test says so.

/** Simple moving average: the plain average of the last `period` values. */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let running = 0;
  for (let i = 0; i < values.length; i++) {
    running += values[i];
    if (i >= period) running -= values[i - period];
    if (i >= period - 1) out[i] = running / period;
  }
  return out;
}

/**
 * Exponential moving average: like the SMA, but recent days count for more.
 * `k` is how much weight today gets; the rest goes to yesterday's EMA.
 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values, as the Python does.
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiFrom(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder's RSI, 0–100: how hard the recent ups were compared with the downs. */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    gains += Math.max(diff, 0);
    losses += Math.max(-diff, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = rsiFrom(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

/** MACD: fast EMA minus slow EMA, plus a signal line and the gap between them. */
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line = emaFast.map((f, i) =>
    f !== null && emaSlow[i] !== null ? f - emaSlow[i] : null);

  // The signal is an EMA of only the MACD values that exist, put back in place.
  const valid = [];
  line.forEach((m, i) => { if (m !== null) valid.push([i, m]); });
  const sig = new Array(values.length).fill(null);
  if (valid.length >= signal) {
    const smoothed = ema(valid.map(([, m]) => m), signal);
    valid.forEach(([idx], j) => { sig[idx] = smoothed[j]; });
  }
  const hist = line.map((m, i) => (m !== null && sig[i] !== null ? m - sig[i] : null));
  return { macd: line, signal: sig, hist };
}

/** Bollinger Bands: the SMA, and lines `mult` standard deviations above and below. */
export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const mean = mid[i];
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

function round(series, digits = 4) {
  const f = 10 ** digits;
  return series.map((v) => (v === null ? null : Math.round(v * f) / f));
}

/**
 * The standard set, in the exact shape /api/candles returns under
 * `indicators`, so the chart can't tell which side computed them.
 */
export function computeAll(close) {
  const m = macd(close);
  const bb = bollinger(close);
  return {
    sma20: round(sma(close, 20)),
    sma50: round(sma(close, 50)),
    sma200: round(sma(close, 200)),
    ema20: round(ema(close, 20)),
    bb_mid: round(bb.mid),
    bb_upper: round(bb.upper),
    bb_lower: round(bb.lower),
    rsi: round(rsi(close, 14)),
    macd: round(m.macd),
    macd_signal: round(m.signal),
    macd_hist: round(m.hist),
  };
}
