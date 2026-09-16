"""Intraday levels and session stats for day-trader mode. Pure math, no I/O.

Day trading asks different questions than investing: not "is this a good
company" but "where is this thing likely to turn today, and how much room is
left in the move". Everything here answers that second question from the
session's own bars plus the previous session's range.

Consumed by /api/daytrade. Same determinism contract as metrics.py.
"""

from __future__ import annotations

import math

from .stats_util import mean, stdev

# A US regular session is 6.5 hours (09:30-16:00 exchange time).
SESSION_OPEN = "09:30"
SESSION_CLOSE = "16:00"


def regular_hours(candles: dict) -> tuple[dict, str]:
    """Return the most recent session's regular-hours bars, plus its status.

    The provider fetches intraday with prepost=True so prices stay fresh outside
    the session, but thin pre-market prints blow up the session high/low and make
    "range used" nonsense. Day-trade levels want RTH only; the chart still gets
    the full extended series.

    Crucially, when the newest day has no regular-hours bars yet — i.e. it's
    pre-market, which is exactly when a day trader is planning — we fall back to
    the last COMPLETED session rather than reporting two meaningless overnight
    prints. The returned status tells the UI which it got.

    Bar timestamps are "YYYY-MM-DD HH:MM" in exchange wall-clock, so the filter
    is a plain string compare.

    Returns (candles_subset, status) where status is one of:
      "live"      — regular-hours bars from the newest day
      "premarket" — newest day has no RTH bars; these are the previous session's
      "extended"  — no RTH bars anywhere; falling back to whatever exists
    """
    dates = candles.get("dates") or []
    if not dates:
        return candles, "empty"

    def slice_to(indices):
        out = {"dates": [dates[i] for i in indices]}
        for key in ("open", "high", "low", "close", "volume"):
            series = candles.get(key) or []
            out[key] = [series[i] for i in indices if i < len(series)]
        return out

    def rth_for(day):
        return [i for i, d in enumerate(dates)
                if d[:10] == day and SESSION_OPEN <= d[11:16] < SESSION_CLOSE]

    days = sorted({d[:10] for d in dates}, reverse=True)
    newest = days[0]

    keep = rth_for(newest)
    if keep:
        return slice_to(keep), "live"

    # Pre-market: use the newest day that actually has a session.
    for day in days[1:]:
        keep = rth_for(day)
        if keep:
            return slice_to(keep), "premarket"

    # No clock times at all (or an all-extended window) — use the newest day.
    return slice_to([i for i, d in enumerate(dates) if d[:10] == newest]), "extended"


# ---------------------------------------------------------------------------
# Volatility
# ---------------------------------------------------------------------------
def true_range(high: list[float], low: list[float], close: list[float]) -> list[float]:
    """Wilder's true range: the day's range, widened to include any overnight gap."""
    out = []
    for i in range(len(close)):
        if i == 0:
            out.append(high[i] - low[i])
        else:
            prev = close[i - 1]
            out.append(max(high[i] - low[i], abs(high[i] - prev), abs(low[i] - prev)))
    return out


def atr(high: list[float], low: list[float], close: list[float],
        period: int = 14) -> float | None:
    """Average true range, Wilder-smoothed. The standard stop-distance unit."""
    tr = true_range(high, low, close)
    if len(tr) < period:
        return None
    val = mean(tr[:period])
    for t in tr[period:]:
        val = (val * (period - 1) + t) / period
    return val


# ---------------------------------------------------------------------------
# Levels
# ---------------------------------------------------------------------------
def pivot_points(prev_high: float, prev_low: float, prev_close: float) -> dict:
    """Classic floor-trader pivots from the previous session's range.

    These are the levels the most people are watching, which is most of why they
    work at all — they are self-fulfilling far more than they are predictive.
    """
    if not all(isinstance(v, (int, float)) for v in (prev_high, prev_low, prev_close)):
        return {}
    p = (prev_high + prev_low + prev_close) / 3.0
    rng = prev_high - prev_low
    return {
        "pivot": round(p, 2),
        "r1": round(2 * p - prev_low, 2),
        "r2": round(p + rng, 2),
        "r3": round(prev_high + 2 * (p - prev_low), 2),
        "s1": round(2 * p - prev_high, 2),
        "s2": round(p - rng, 2),
        "s3": round(prev_low - 2 * (prev_high - p), 2),
        "prev_high": round(prev_high, 2),
        "prev_low": round(prev_low, 2),
        "prev_close": round(prev_close, 2),
    }


def vwap(high: list[float], low: list[float], close: list[float],
         volume: list[float]) -> float | None:
    """Volume-weighted average price over the supplied bars.

    Caller must pass a single session's bars — VWAP resets at the open and means
    nothing across a multi-day window.
    """
    num = den = 0.0
    for i in range(len(close)):
        v = volume[i] if i < len(volume) and volume[i] else 0.0
        typical = (high[i] + low[i] + close[i]) / 3.0
        num += typical * v
        den += v
    return num / den if den else None


def opening_range(high: list[float], low: list[float], bars: int = 6) -> dict:
    """High/low of the first `bars` bars — 30 minutes at a 5-minute interval.

    A break of the opening range is the most-traded intraday setup there is, so
    the levels are worth showing even though the breakout itself is a coin flip.
    """
    if len(high) < bars or len(low) < bars:
        return {}
    orh, orl = max(high[:bars]), min(low[:bars])
    return {
        "high": round(orh, 2),
        "low": round(orl, 2),
        "range": round(orh - orl, 2),
        "bars": bars,
    }


# ---------------------------------------------------------------------------
# Session roll-up
# ---------------------------------------------------------------------------
def session_stats(open_: list[float], high: list[float], low: list[float],
                  close: list[float], volume: list[float],
                  prev_close: float | None = None,
                  daily_atr: float | None = None) -> dict:
    """Where the current session sits: gap, range used, position in range, RVOL."""
    if not close:
        return {}
    s_open, s_high, s_low, last = open_[0], max(high), min(low), close[-1]
    rng = s_high - s_low

    out = {
        "open": round(s_open, 2),
        "high": round(s_high, 2),
        "low": round(s_low, 2),
        "last": round(last, 2),
        "range": round(rng, 2),
        "range_pct": round(rng / s_open * 100, 2) if s_open else None,
        # 0% = sitting on the session low, 100% = on the high.
        "position_in_range_pct": round((last - s_low) / rng * 100, 1) if rng else None,
        "change_from_open_pct": round((last / s_open - 1) * 100, 2) if s_open else None,
        "bars": len(close),
        "volume": round(sum(v for v in volume if v), 0) if volume else None,
    }

    if prev_close:
        out["gap_pct"] = round((s_open / prev_close - 1) * 100, 2)
        out["change_pct"] = round((last / prev_close - 1) * 100, 2)

    if daily_atr:
        # How much of a typical day's range has already been spent. Above ~100%
        # means the move is extended and continuation trades get expensive.
        out["atr"] = round(daily_atr, 2)
        out["range_used_pct"] = round(rng / daily_atr * 100, 1) if daily_atr else None
        out["atr_pct_of_price"] = round(daily_atr / last * 100, 2) if last else None

    return out


def suggested_stops(last: float, daily_atr: float | None) -> dict:
    """ATR-multiple stop distances. Sizing arithmetic, not a recommendation."""
    if not last or not daily_atr:
        return {}
    return {
        "atr": round(daily_atr, 2),
        "long": {
            "tight_1x": round(last - daily_atr, 2),
            "normal_1_5x": round(last - 1.5 * daily_atr, 2),
            "wide_2x": round(last - 2 * daily_atr, 2),
        },
        "short": {
            "tight_1x": round(last + daily_atr, 2),
            "normal_1_5x": round(last + 1.5 * daily_atr, 2),
            "wide_2x": round(last + 2 * daily_atr, 2),
        },
        "note": "ATR multiples. Wider stops need smaller size for the same risk.",
    }


def position_size(account_value: float, risk_pct: float, entry: float,
                  stop: float) -> dict:
    """Shares that keep the loss at `risk_pct` of the account if the stop hits.

    This is the one piece of day-trading maths that is actually not opinion.
    """
    if not (account_value > 0 and entry > 0 and 0 < risk_pct <= 100):
        return {}
    per_share = abs(entry - stop)
    if per_share <= 0:
        return {}
    risk_dollars = account_value * risk_pct / 100.0
    shares = math.floor(risk_dollars / per_share)
    return {
        "shares": shares,
        "risk_dollars": round(risk_dollars, 2),
        "risk_per_share": round(per_share, 4),
        "position_value": round(shares * entry, 2),
        "position_pct_of_account": round(shares * entry / account_value * 100, 1),
    }


def intraday_volatility(close: list[float]) -> dict:
    """Bar-to-bar movement stats — the texture a scalper actually trades."""
    if len(close) < 5:
        return {}
    moves = [abs(close[i] / close[i - 1] - 1) * 100
             for i in range(1, len(close)) if close[i - 1]]
    if not moves:
        return {}
    return {
        "avg_bar_move_pct": round(mean(moves), 3),
        "max_bar_move_pct": round(max(moves), 3),
        "bar_move_stdev_pct": round(stdev(moves), 3),
    }


# ---------------------------------------------------------------------------
# Bundle
# ---------------------------------------------------------------------------
def daytrade_levels(symbol: str, intraday: dict, daily: dict) -> dict:
    """Everything /api/daytrade returns.

    `intraday` is one session of fine-grained bars; `daily` is ~3 months of daily
    bars, used for ATR and for the previous session's pivot inputs.
    """
    session, status = regular_hours(intraday)
    i_o = session.get("open", [])
    i_h, i_l = session.get("high", []), session.get("low", [])
    i_c, i_v = session.get("close", []), session.get("volume", [])
    d_d = daily.get("dates", [])
    d_h, d_l = daily.get("high", []), daily.get("low", [])
    d_c = daily.get("close", [])

    day_atr = atr(d_h, d_l, d_c) if len(d_c) >= 15 else None

    # Pivots are always derived from the last COMPLETED session, because they're
    # the levels for the session being traded.
    #
    #   live      -> the session shown is today, so pivots come from the bar
    #                BEFORE it (yesterday).
    #   premarket -> the session shown is already finished, and it's what drives
    #                the session about to open, so pivots come from it directly.
    session_day = (session.get("dates") or [""])[-1][:10]
    day_idx = next((i for i, d in enumerate(d_d) if d[:10] == session_day), None)

    if day_idx is None:
        pivot_idx = len(d_c) - 2 if len(d_c) >= 2 else None
    elif status == "premarket":
        pivot_idx = day_idx
    else:
        pivot_idx = day_idx - 1 if day_idx >= 1 else None

    pivots = (pivot_points(d_h[pivot_idx], d_l[pivot_idx], d_c[pivot_idx])
              if pivot_idx is not None and 0 <= pivot_idx < len(d_c) else {})
    prev_close = (d_c[pivot_idx]
                  if pivot_idx is not None and 0 <= pivot_idx < len(d_c) else None)

    # Quote the true latest print (which may be extended-hours) even though the
    # session stats below are regular-hours only.
    last = (intraday.get("close") or i_c or d_c or [None])[-1]
    stats = session_stats(i_o, i_h, i_l, i_c, i_v, prev_close, day_atr) if i_c else {}
    session_vwap = vwap(i_h, i_l, i_c, i_v) if i_c else None

    return {
        "symbol": symbol.upper(),
        "as_of": (intraday.get("dates") or [None])[-1],
        "session_date": session_day or None,
        # "live" | "premarket" | "extended" — premarket means the stats below
        # describe the PREVIOUS session, which is the useful thing before the bell.
        "session_status": status,
        "last": round(last, 2) if last else None,
        "session": stats,
        "vwap": round(session_vwap, 2) if session_vwap else None,
        "vs_vwap_pct": (round((last / session_vwap - 1) * 100, 2)
                        if session_vwap and last else None),
        "opening_range": opening_range(i_h, i_l),
        "pivots": pivots,
        "stops": suggested_stops(last, day_atr) if last else {},
        "intraday_volatility": intraday_volatility(i_c),
    }
