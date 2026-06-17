"""Technical indicators. Pure functions over a close (and volume) series.

Every function returns a list the SAME LENGTH as the input, with `None` in the
warm-up region where there isn't enough data yet. That keeps every series
aligned to the same date axis on the frontend — the chart just skips the Nones.

This lives in `core/` so the offline Streamlit path and the online API compute
identical indicators.
"""

from __future__ import annotations


def sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if period <= 0:
        return out
    running = 0.0
    for i, v in enumerate(values):
        running += v
        if i >= period:
            running -= values[i - period]
        if i >= period - 1:
            out[i] = running / period
    return out


def ema(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    k = 2 / (period + 1)
    # seed with the SMA of the first `period` values
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values: list[float], period: int = 14) -> list[float | None]:
    """Wilder's RSI."""
    out: list[float | None] = [None] * len(values)
    if len(values) <= period:
        return out
    gains, losses = 0.0, 0.0
    for i in range(1, period + 1):
        diff = values[i] - values[i - 1]
        gains += max(diff, 0.0)
        losses += max(-diff, 0.0)
    avg_gain, avg_loss = gains / period, losses / period
    out[period] = _rsi_from(avg_gain, avg_loss)
    for i in range(period + 1, len(values)):
        diff = values[i] - values[i - 1]
        gain = max(diff, 0.0)
        loss = max(-diff, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = _rsi_from(avg_gain, avg_loss)
    return out


def _rsi_from(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def macd(values: list[float], fast: int = 12, slow: int = 26, signal: int = 9):
    """Returns (macd_line, signal_line, histogram), each aligned to `values`."""
    ema_fast = ema(values, fast)
    ema_slow = ema(values, slow)
    macd_line: list[float | None] = [
        (f - s) if (f is not None and s is not None) else None
        for f, s in zip(ema_fast, ema_slow)
    ]
    # signal = EMA of the non-None macd values, re-aligned to full length
    valid = [(i, m) for i, m in enumerate(macd_line) if m is not None]
    signal_line: list[float | None] = [None] * len(values)
    if len(valid) >= signal:
        seq = [m for _, m in valid]
        sig = ema(seq, signal)
        for (idx, _), s in zip(valid, sig):
            signal_line[idx] = s
    hist: list[float | None] = [
        (m - s) if (m is not None and s is not None) else None
        for m, s in zip(macd_line, signal_line)
    ]
    return macd_line, signal_line, hist


def bollinger(values: list[float], period: int = 20, mult: float = 2.0):
    """Returns (mid, upper, lower) Bollinger Bands."""
    mid = sma(values, period)
    upper: list[float | None] = [None] * len(values)
    lower: list[float | None] = [None] * len(values)
    for i in range(len(values)):
        if i >= period - 1:
            window = values[i - period + 1: i + 1]
            mean = mid[i]
            var = sum((x - mean) ** 2 for x in window) / period
            sd = var ** 0.5
            upper[i] = mean + mult * sd
            lower[i] = mean - mult * sd
    return mid, upper, lower


def compute_all(close: list[float]) -> dict:
    """Bundle the standard indicator set for the API/chart in one call."""
    macd_line, macd_signal, macd_hist = macd(close)
    bb_mid, bb_upper, bb_lower = bollinger(close)
    return {
        "sma20": _round(sma(close, 20)),
        "sma50": _round(sma(close, 50)),
        "sma200": _round(sma(close, 200)),
        "ema20": _round(ema(close, 20)),
        "bb_mid": _round(bb_mid),
        "bb_upper": _round(bb_upper),
        "bb_lower": _round(bb_lower),
        "rsi": _round(rsi(close, 14)),
        "macd": _round(macd_line),
        "macd_signal": _round(macd_signal),
        "macd_hist": _round(macd_hist),
    }


def _round(series: list[float | None], digits: int = 4) -> list[float | None]:
    return [round(v, digits) if v is not None else None for v in series]
