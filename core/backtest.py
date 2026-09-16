"""Does the signal score actually predict anything? Pure math, no I/O, no AI.

Walks the price history bar by bar, scores each day using only the data that
existed by then, and records what happened over the following N trading days.
Then it buckets those observations by score band and reports the average forward
return and hit rate for each.

The point is falsification, not promotion. If the bullish bucket doesn't beat the
bearish bucket, the score is decoration and the UI says so. A dashboard that
shows a signal without ever checking it is selling confidence it hasn't earned.

Two honesty guards matter here:

  * NO LOOKAHEAD. Every indicator in `compute_all` is a causal rolling series, so
    reading index i uses only close[:i+1]. The forward return is then measured
    from i to i+horizon, which is strictly future data never fed to the score.
  * OVERLAPPING SAMPLES. Consecutive days share most of their forward window, so
    the observations are heavily autocorrelated and the effective sample size is
    far smaller than the raw count. `independent_samples` reports the honest
    figure (n / horizon), and short histories are labelled unreliable.
"""

from __future__ import annotations

from . import indicators
from .forecast import _score_label, signal_at
from .stats_util import mean, stdev

# Score bands the results are bucketed into. Must line up with _score_label.
BANDS = [
    ("strong-bearish", -100.0, -40.0),
    ("bearish", -40.0, -15.0),
    ("neutral", -15.0, 15.0),
    ("bullish", 15.0, 40.0),
    ("strong-bullish", 40.0, 100.01),
]

# Below this many independent samples the numbers are noise, and we say so.
MIN_INDEPENDENT = 12


def _band_for(score: float) -> str:
    for name, lo, hi in BANDS:
        if lo <= score < hi:
            return name
    return "strong-bullish" if score > 0 else "strong-bearish"


def backtest_signal(close: list[float], volume: list[float] | None = None,
                    horizon: int = 21, warmup: int = 200) -> dict:
    """Score every bar and measure the forward `horizon`-day return.

    `warmup` skips the early bars where the slow indicators (SMA200) haven't
    filled in, so the early scores aren't computed from a different, thinner set
    of factors than the later ones.
    """
    n = len(close)
    if n < warmup + horizon + 20:
        return {"available": False,
                "reason": f"Needs at least {warmup + horizon + 20} bars of history; "
                          f"got {n}."}

    ind = indicators.compute_all(close)
    observations = []

    for i in range(warmup, n - horizon):
        s = signal_at(ind, close, volume, i)
        if not s:
            continue
        entry, exit_ = close[i], close[i + horizon]
        if not entry:
            continue
        observations.append({
            "i": i,
            "score": s["score"],
            "band": _band_for(s["score"]),
            "forward_pct": (exit_ / entry - 1) * 100,
        })

    if not observations:
        return {"available": False, "reason": "No scoreable bars in range."}

    forwards = [o["forward_pct"] for o in observations]
    baseline = mean(forwards)

    buckets = []
    for name, _, _ in BANDS:
        rows = [o for o in observations if o["band"] == name]
        if not rows:
            buckets.append({"band": name, "n": 0})
            continue
        fw = [o["forward_pct"] for o in rows]
        wins = sum(1 for x in fw if x > 0)
        buckets.append({
            "band": name,
            "n": len(rows),
            "avg_forward_pct": round(mean(fw), 2),
            "median_forward_pct": round(sorted(fw)[len(fw) // 2], 2),
            "hit_rate_pct": round(wins / len(fw) * 100, 1),
            "best_pct": round(max(fw), 2),
            "worst_pct": round(min(fw), 2),
            "stdev_pct": round(stdev(fw), 2),
            # The only number that matters: did this band beat doing nothing?
            "excess_vs_baseline_pct": round(mean(fw) - baseline, 2),
        })

    scored = [b for b in buckets if b["n"] > 0 and "avg_forward_pct" in b]
    bull = next((b for b in scored if b["band"] == "strong-bullish"), None) \
        or next((b for b in scored if b["band"] == "bullish"), None)
    bear = next((b for b in scored if b["band"] == "strong-bearish"), None) \
        or next((b for b in scored if b["band"] == "bearish"), None)

    spread = None
    if bull and bear:
        spread = round(bull["avg_forward_pct"] - bear["avg_forward_pct"], 2)

    independent = len(observations) // horizon
    monotonic = _is_monotonic([b["avg_forward_pct"] for b in scored])

    return {
        "available": True,
        "horizon": horizon,
        "bars_tested": len(observations),
        # Overlapping windows mean the raw count massively overstates evidence.
        "independent_samples": independent,
        "baseline_forward_pct": round(baseline, 2),
        "buckets": buckets,
        "bull_minus_bear_pct": spread,
        "monotonic": monotonic,
        "verdict": _verdict(spread, monotonic, independent),
        "reliable": independent >= MIN_INDEPENDENT,
    }


def _is_monotonic(values: list[float]) -> bool:
    """Do average forward returns rise as the score band rises?

    This is a stronger test than "bullish beat bearish" — it asks whether the
    score is informative across its whole range rather than at the extremes only.
    """
    return len(values) >= 3 and all(
        values[i] <= values[i + 1] + 1e-9 for i in range(len(values) - 1))


def _verdict(spread: float | None, monotonic: bool, independent: int) -> str:
    if independent < MIN_INDEPENDENT:
        return "insufficient-data"
    if spread is None:
        return "insufficient-data"
    if spread > 1.0 and monotonic:
        return "predictive"
    if spread > 1.0:
        return "weak-signal"
    if spread < -1.0:
        return "inverted"      # worth knowing: the score points the wrong way
    return "no-edge"


VERDICT_TEXT = {
    "predictive": "Higher scores were followed by better returns, consistently "
                  "across the range. The signal carried information over this "
                  "history.",
    "weak-signal": "Bullish scores beat bearish ones, but not consistently across "
                   "the middle of the range. Treat the extremes as mildly "
                   "informative and the middle as noise.",
    "no-edge": "Bullish and bearish scores were followed by roughly the same "
               "returns. Over this history the score had no predictive value — "
               "read it as a description of the present, not a forecast.",
    "inverted": "Bearish scores were followed by BETTER returns than bullish ones. "
                "Over this window the score pointed the wrong way, which is a "
                "mean-reversion regime, not a reason to trade it backwards.",
    "insufficient-data": "Not enough independent observations to say anything. "
                         "Overlapping forward windows make the raw bar count "
                         "misleading.",
}


def backtest_summary(result: dict) -> str:
    """One-line plain-English reading of the result, for the UI and the AI."""
    if not result.get("available"):
        return result.get("reason", "Backtest unavailable.")
    return VERDICT_TEXT.get(result["verdict"], "")
