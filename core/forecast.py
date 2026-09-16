"""Price projection + signal scoring. Pure math, no I/O, no AI.

This is the "predictions" layer. Everything here is deterministic given the
input series, so the offline Streamlit path and the online API produce identical
numbers — same contract as metrics.py.

Three independent views, deliberately kept separate so a user can see when they
disagree (that disagreement is itself information):

  1. `trend_projection`  — log-linear regression extrapolated forward.
  2. `probability_bands` — geometric-Brownian-motion percentile cone.
  3. `signal_score`      — weighted technical composite, -100..+100.

None of these are advice. Drift is deliberately damped (see DRIFT_SHRINK)
because naively extrapolating a hot 6-month run is the single most misleading
thing a forecast tool can do.
"""

from __future__ import annotations

import math

from . import indicators
from .stats_util import (
    clamp, linreg, log_returns, mean, norm_cdf, norm_ppf, percentile, stdev,
)

TRADING_DAYS = 252

# Historical drift is a poor predictor of future drift, so shrink it toward zero
# rather than extrapolating the full trailing slope.
DRIFT_SHRINK = 0.5

# Horizons offered by default, in trading days.
HORIZONS = {"1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252}

# Below this daily sigma the GBM formulas degenerate (division blows up). Real
# equities are ~0.01-0.05; this only trips on synthetic or dead series.
_MIN_SIGMA = 1e-8


# ---------------------------------------------------------------------------
# 1. Log-linear trend
# ---------------------------------------------------------------------------
def trend_projection(closes: list[float], horizons: dict[str, int] | None = None) -> dict:
    """Fit log(price) against time and extend the line forward.

    r_squared says how well the stock has actually followed a straight line — a
    projection with r2 of 0.1 is noise dressed up as a number, and the UI labels
    it that way.
    """
    horizons = horizons or HORIZONS
    logs = [math.log(c) for c in closes if c and c > 0]
    if len(logs) < 10:
        return {}

    intercept, slope, r2 = linreg(logs)
    n = len(logs)
    last = closes[-1]
    fitted_now = math.exp(intercept + slope * (n - 1))

    projections = {label: round(math.exp(intercept + slope * (n - 1 + days)), 2)
                   for label, days in horizons.items()}

    return {
        "r_squared": round(r2, 4),
        "daily_drift_pct": round((math.exp(slope) - 1) * 100, 4),
        "annualized_drift_pct": round((math.exp(slope * TRADING_DAYS) - 1) * 100, 2),
        "fit_price": round(fitted_now, 2),
        # How far price sits above/below its own trend line right now.
        "deviation_from_trend_pct": (round((last / fitted_now - 1) * 100, 2)
                                     if fitted_now else None),
        "projections": projections,
        "fit_quality": "strong" if r2 >= 0.7 else "moderate" if r2 >= 0.4 else "weak",
    }


# ---------------------------------------------------------------------------
# 2. GBM probability cone
# ---------------------------------------------------------------------------
def probability_bands(closes: list[float], horizons: dict[str, int] | None = None,
                      drift_shrink: float = DRIFT_SHRINK) -> dict:
    """Lognormal percentile cone from the trailing drift and volatility.

    Solved analytically rather than by simulation: for GBM the terminal
    distribution is exactly lognormal, so Monte Carlo would only add noise and
    non-determinism to a number we can write down.
    """
    horizons = horizons or HORIZONS
    rets = log_returns(closes)
    if len(rets) < 20:
        return {}

    mu_raw = mean(rets)
    sigma = stdev(rets)
    mu = mu_raw * drift_shrink
    last = closes[-1]

    levels = [5, 25, 50, 75, 95]
    out = {}
    for label, days in horizons.items():
        drift = mu * days
        sd = sigma * math.sqrt(days)
        band = {f"p{p}": round(last * math.exp(drift + norm_ppf(p / 100.0) * sd), 2)
                for p in levels}
        # P(price above today's price at the horizon).
        band["prob_gain_pct"] = round(norm_cdf(drift / sd) * 100 if sd else 50.0, 1)
        band["expected_move_pct"] = round((math.exp(sd) - 1) * 100, 2)
        out[label] = band

    return {
        "daily_volatility_pct": round(sigma * 100, 3),
        "annualized_volatility_pct": round(sigma * math.sqrt(TRADING_DAYS) * 100, 2),
        "drift_shrink": drift_shrink,
        "raw_annualized_drift_pct": round((math.exp(mu_raw * TRADING_DAYS) - 1) * 100, 2),
        "bands": out,
    }


def probability_of_touch(closes: list[float], target: float, days: int,
                         drift_shrink: float = DRIFT_SHRINK) -> dict:
    """P(price touches `target` at any point within `days`) under GBM.

    First-passage probability, not the terminal probability — a level can be hit
    and given back, which is exactly what matters when you are setting a stop or
    a take-profit.
    """
    rets = log_returns(closes)
    if len(rets) < 20 or not closes or target <= 0 or days <= 0:
        return {}
    last = closes[-1]
    sigma = stdev(rets)
    mu = mean(rets) * drift_shrink
    # A series with (near-)zero measured volatility makes the reflection term
    # 2*mu*b/sigma^2 explode. That happens on synthetic/illiquid series where
    # every bar moves identically, so degrade to the deterministic answer
    # instead of raising OverflowError.
    if sigma <= _MIN_SIGMA or last <= 0:
        drifted = last * math.exp(mu * days)
        hit = drifted >= target if target > last else drifted <= target
        return {
            "target": round(target, 2), "current": round(last, 2), "days": days,
            "direction": "above" if target > last else "below",
            "distance_pct": round((target / last - 1) * 100, 2) if last else None,
            "probability_pct": 100.0 if hit else 0.0,
            "degenerate": True,
        }

    b = math.log(target / last)
    t = float(days)
    sd = sigma * math.sqrt(t)
    if b == 0:
        p = 1.0
    else:
        # exp() of anything past ~709 overflows a float; the reflection term is
        # a probability multiplier, so saturating it is the correct limit.
        reflect = math.exp(min(2 * mu * b / sigma ** 2, 700.0))
        if b > 0:   # upside barrier
            p = norm_cdf((-b + mu * t) / sd) + reflect * norm_cdf((-b - mu * t) / sd)
        else:       # downside barrier
            p = norm_cdf((b - mu * t) / sd) + reflect * norm_cdf((b + mu * t) / sd)

    return {
        "target": round(target, 2),
        "current": round(last, 2),
        "days": days,
        "direction": "above" if b > 0 else "below",
        "distance_pct": round((target / last - 1) * 100, 2),
        "probability_pct": round(min(max(p, 0.0), 1.0) * 100, 1),
    }


# ---------------------------------------------------------------------------
# 3. Technical composite score
# ---------------------------------------------------------------------------
# Each factor scores -1 (bearish) .. +1 (bullish); weights sum to 1.0.
_WEIGHTS = {
    "trend": 0.30,
    "momentum": 0.20,
    "macd": 0.20,
    "mean_reversion": 0.15,
    "volume": 0.15,
}


def signal_score(close: list[float], volume: list[float] | None = None) -> dict:
    """Weighted blend of the standard indicator set into one -100..+100 number.

    Returns the per-factor breakdown too — a single score with no explanation is
    exactly the kind of black box this dashboard is meant to avoid.
    """
    if len(close) < 30:
        return {}
    return signal_at(indicators.compute_all(close), close, volume, len(close) - 1)


def signal_at(ind: dict, close: list[float], volume: list[float] | None,
              i: int) -> dict:
    """Score the series AS OF index `i`, using only data available by then.

    Split out from signal_score so the backtester can walk history without
    recomputing indicators on every bar. Every indicator in `ind` is a causal
    rolling series — the value at index i depends only on close[:i+1] — so
    reading position i is genuinely point-in-time and not lookahead.
    """
    if i < 29 or i >= len(close):
        return {}

    last = close[i]
    factors: dict[str, dict] = {}

    def at(key):
        """Latest non-None value of `key` at or before bar i."""
        series = ind.get(key)
        if not series:
            return None
        for j in range(min(i, len(series) - 1), -1, -1):
            if series[j] is not None:
                return series[j]
        return None

    def add(key, value, note):
        factors[key] = {"score": round(clamp(value), 3),
                        "weight": _WEIGHTS[key], "note": note}

    # -- trend: price relative to SMA50, adjusted by the 50/200 relationship.
    sma50 = at("sma50")
    sma200 = at("sma200")
    if sma50:
        t = clamp((last / sma50 - 1) * 10)  # +/-10% from SMA50 saturates
        if sma200:
            t = clamp(t + (0.4 if sma50 > sma200 else -0.4))
            note = (f"price {_rel(last, sma50)} SMA50; SMA50 "
                    f"{_rel(sma50, sma200)} SMA200 "
                    f"({'golden' if sma50 > sma200 else 'death'}-cross regime)")
        else:
            note = f"price {_rel(last, sma50)} SMA50 (not enough history for SMA200)"
        add("trend", t, note)

    # -- momentum: RSI, centred on 50.
    rsi = at("rsi")
    if rsi is not None:
        state = "overbought" if rsi > 70 else "oversold" if rsi < 30 else "neutral range"
        add("momentum", (rsi - 50) / 30.0, f"RSI {rsi:.1f} — {state}")

    # -- macd: histogram scaled by price so it compares across symbols.
    hist = at("macd_hist")
    if hist is not None and last:
        add("macd", (hist / last) * 200,
            f"MACD histogram {hist:+.3f} — "
            f"{'bullish' if hist > 0 else 'bearish'} crossover state")

    # -- mean reversion: %B inside the Bollinger band, deliberately inverted.
    up, lo = at("bb_upper"), at("bb_lower")
    if up and lo and up > lo:
        pct_b = (last - lo) / (up - lo)
        stretch = ("stretched high" if pct_b > 0.8
                   else "stretched low" if pct_b < 0.2 else "mid-band")
        add("mean_reversion", (0.5 - pct_b) * 2,
            f"{pct_b * 100:.0f}% of the way up the Bollinger band — {stretch}")

    # -- volume: is recent activity confirming the recent move?
    if volume and len(volume) > i and i >= 30:
        recent = mean(volume[i - 4:i + 1])
        base = mean(volume[i - 29:i + 1])
        direction = 1.0 if close[i] >= close[i - 5] else -1.0
        conviction = clamp((recent / base - 1) * 2) if base else 0.0
        add("volume", direction * abs(conviction),
            f"5-day volume {recent / base * 100:.0f}% of the 30-day average, on a "
            f"{'rising' if direction > 0 else 'falling'} week" if base else "no volume baseline")

    if not factors:
        return {}

    total_w = sum(f["weight"] for f in factors.values())
    raw = sum(f["score"] * f["weight"] for f in factors.values()) / total_w
    score = round(raw * 100, 1)
    return {
        "score": score,
        "label": _score_label(score),
        # What share of the factor weights actually had data behind them.
        "confidence_pct": round(total_w * 100),
        "factors": factors,
    }


def _score_label(s: float) -> str:
    if s >= 40:
        return "strong-bullish"
    if s >= 15:
        return "bullish"
    if s > -15:
        return "neutral"
    if s > -40:
        return "bearish"
    return "strong-bearish"


def _last(series):
    if not series:
        return None
    for v in reversed(series):
        if v is not None:
            return v
    return None


def _rel(a, b):
    return "above" if a > b else "below"


# ---------------------------------------------------------------------------
# 4. Risk statistics
# ---------------------------------------------------------------------------
def risk_metrics(closes: list[float], risk_free_pct: float = 4.0) -> dict:
    """Risk-adjusted return stats over the supplied series."""
    rets = log_returns(closes)
    if len(rets) < 20:
        return {}
    mu_d, sd_d = mean(rets), stdev(rets)
    ann_ret = (math.exp(mu_d * TRADING_DAYS) - 1) * 100
    ann_vol = sd_d * math.sqrt(TRADING_DAYS) * 100

    # Downside deviation divides by the FULL sample, not just the losing days —
    # that is the standard Sortino convention.
    downside = [r for r in rets if r < 0]
    dd_dev = (math.sqrt(sum(r ** 2 for r in downside) / len(rets))
              * math.sqrt(TRADING_DAYS) * 100) if downside else 0.0

    var95 = percentile(rets, 5)
    tail = [r for r in rets if var95 is not None and r <= var95]

    return {
        "annualized_return_pct": round(ann_ret, 2),
        "annualized_volatility_pct": round(ann_vol, 2),
        "sharpe": round((ann_ret - risk_free_pct) / ann_vol, 2) if ann_vol else None,
        "sortino": round((ann_ret - risk_free_pct) / dd_dev, 2) if dd_dev else None,
        "downside_deviation_pct": round(dd_dev, 2),
        # One-day 95% VaR: on the worst 5% of days you lose at least this much.
        "var_95_pct": round((math.exp(var95) - 1) * 100, 2) if var95 is not None else None,
        "cvar_95_pct": round((math.exp(mean(tail)) - 1) * 100, 2) if tail else None,
        "best_day_pct": round((math.exp(max(rets)) - 1) * 100, 2),
        "worst_day_pct": round((math.exp(min(rets)) - 1) * 100, 2),
        "positive_days_pct": round(sum(1 for r in rets if r > 0) / len(rets) * 100, 1),
        "risk_free_pct": risk_free_pct,
    }


# ---------------------------------------------------------------------------
# 5. Support / resistance
# ---------------------------------------------------------------------------
def support_resistance(high: list[float], low: list[float], close: list[float],
                       swing: int = 5, max_levels: int = 4) -> dict:
    """Swing-pivot levels clustered into zones around the current price.

    A pivot is a bar whose high (low) is the highest (lowest) of the `swing` bars
    either side of it. Nearby pivots are merged so the UI shows four real zones
    instead of forty near-identical lines.
    """
    n = len(close)
    if n < swing * 2 + 5 or len(high) != n or len(low) != n:
        return {}
    last = close[-1]

    highs, lows = [], []
    for i in range(swing, n - swing):
        if high[i] == max(high[i - swing:i + swing + 1]):
            highs.append(high[i])
        if low[i] == min(low[i - swing:i + swing + 1]):
            lows.append(low[i])

    # Cluster within 1.5% of each other; touch count = how many pivots agree.
    def cluster(levels):
        out = []
        for lv in sorted(levels):
            if out and out[-1]["price"] and abs(lv - out[-1]["price"]) / out[-1]["price"] < 0.015:
                grp = out[-1]
                grp["touches"] += 1
                grp["price"] = (grp["price"] * (grp["touches"] - 1) + lv) / grp["touches"]
            else:
                out.append({"price": lv, "touches": 1})
        return out

    res = sorted((c for c in cluster(highs) if c["price"] > last),
                 key=lambda c: c["price"])
    sup = sorted((c for c in cluster(lows) if c["price"] < last),
                 key=lambda c: -c["price"])

    def fmt(levels):
        return [{"price": round(c["price"], 2),
                 "touches": c["touches"],
                 "distance_pct": round((c["price"] / last - 1) * 100, 2)}
                for c in levels[:max_levels]]

    return {"current": round(last, 2), "resistance": fmt(res), "support": fmt(sup)}


# ---------------------------------------------------------------------------
# Bundle
# ---------------------------------------------------------------------------
def forecast(symbol: str, dates: list[str], open_: list[float], high: list[float],
             low: list[float], close: list[float], volume: list[float]) -> dict:
    """Everything the /api/forecast endpoint returns for one symbol."""
    return {
        "symbol": symbol.upper(),
        "as_of": dates[-1] if dates else None,
        "current_price": round(close[-1], 2) if close else None,
        "points": len(close),
        "trend": trend_projection(close),
        "bands": probability_bands(close),
        "signal": signal_score(close, volume),
        "risk": risk_metrics(close),
        "levels": support_resistance(high, low, close),
    }


# ---------------------------------------------------------------------------
# 6. Portfolio-level projection
# ---------------------------------------------------------------------------
def portfolio_series(histories: dict, shares: dict) -> tuple[list[str], list[float]]:
    """Reconstruct the book's total value over the dates all symbols share.

    Uses TODAY's share counts throughout, so the series answers "how would this
    exact book have moved" rather than mixing in the timing of past purchases.
    Dates are intersected because a symbol with a shorter history would
    otherwise silently shift the others.
    """
    symbols = [s for s, h in histories.items()
               if (h or {}).get("dates") and (h or {}).get("closes") and shares.get(s)]
    if not symbols:
        return [], []

    common = set(histories[symbols[0]]["dates"])
    for s in symbols[1:]:
        common &= set(histories[s]["dates"])
    dates = sorted(common)
    if len(dates) < 30:
        return [], []

    lookup = {s: dict(zip(histories[s]["dates"], histories[s]["closes"]))
              for s in symbols}
    values = [sum(shares[s] * lookup[s][d] for s in symbols) for d in dates]
    return dates, values


def portfolio_forecast(histories: dict, shares: dict,
                       horizons: dict[str, int] | None = None) -> dict:
    """Probability cone for the whole book rather than one symbol.

    This is not the average of the per-symbol cones — correlations between the
    holdings are already baked into the combined value series, so the portfolio
    cone is genuinely narrower than the pieces whenever the book is diversified.
    """
    dates, values = portfolio_series(histories, shares)
    if not values:
        return {"available": False,
                "reason": "Need at least 30 overlapping trading days across the "
                          "holdings."}

    bands = probability_bands(values, horizons)
    if not bands:
        return {"available": False, "reason": "Not enough return history."}

    current = values[-1]
    out = {
        "available": True,
        "current_value": round(current, 2),
        "start_date": dates[0],
        "end_date": dates[-1],
        "n_days": len(dates),
        "n_symbols": len(shares),
        "bands": bands["bands"],
        "annualized_volatility_pct": bands["annualized_volatility_pct"],
        "risk": risk_metrics(values),
        "trend": trend_projection(values),
    }
    # Restate each band as a gain/loss in dollars, which is what people read.
    for label, band in out["bands"].items():
        band["p50_change"] = round(band["p50"] - current, 2)
        band["p5_change"] = round(band["p5"] - current, 2)
        band["p95_change"] = round(band["p95"] - current, 2)
    return out
