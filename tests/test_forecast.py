"""Forecast maths. Deterministic inputs only — no network, no provider."""

import math

import pytest

from core import forecast
from core.stats_util import linreg, norm_cdf, norm_ppf, percentile


def geometric(start, daily_rate, n):
    """Perfectly smooth compounding — zero volatility, useful for trend tests."""
    return [start * (1 + daily_rate) ** i for i in range(n)]


def wobbly(start, daily_rate, n, amplitude=0.012):
    """Compounding WITH volatility, which is what the GBM maths assumes.

    Deterministic (no RNG) so failures are always reproducible, but the returns
    genuinely vary bar to bar, unlike `geometric`.
    """
    out = [start]
    for i in range(1, n):
        # Two incommensurate sine terms: repeats slowly, never exactly.
        shock = amplitude * (math.sin(i * 1.7) + 0.6 * math.sin(i * 0.41))
        out.append(out[-1] * (1 + daily_rate + shock))
    return out


def zigzag(base, amplitude, n):
    """Sawtooth around `base` — trendless but volatile."""
    return [base + amplitude * ((i % 4) - 1.5) for i in range(n)]


# --- stats helpers ---------------------------------------------------------
def test_norm_ppf_matches_known_quantiles():
    assert norm_ppf(0.5) == pytest.approx(0.0, abs=1e-9)
    assert norm_ppf(0.975) == pytest.approx(1.959964, abs=1e-5)
    assert norm_ppf(0.05) == pytest.approx(-1.644854, abs=1e-5)


def test_norm_cdf_inverts_ppf():
    for p in (0.01, 0.1, 0.5, 0.9, 0.99):
        assert norm_cdf(norm_ppf(p)) == pytest.approx(p, abs=1e-6)


def test_percentile_interpolates():
    assert percentile([1, 2, 3, 4], 50) == pytest.approx(2.5)
    assert percentile([1, 2, 3, 4], 0) == 1
    assert percentile([1, 2, 3, 4], 100) == 4
    assert percentile([], 50) is None


def test_linreg_recovers_slope():
    intercept, slope, r2 = linreg([3, 5, 7, 9])
    assert slope == pytest.approx(2.0)
    assert intercept == pytest.approx(3.0)
    assert r2 == pytest.approx(1.0)


# --- trend projection ------------------------------------------------------
def test_trend_projection_on_clean_exponential():
    closes = geometric(100, 0.001, 200)
    t = forecast.trend_projection(closes, {"1M": 21})
    # A perfect log-linear series should fit essentially exactly.
    assert t["r_squared"] == pytest.approx(1.0, abs=1e-6)
    assert t["fit_quality"] == "strong"
    assert t["daily_drift_pct"] == pytest.approx(0.1, abs=1e-3)
    assert t["projections"]["1M"] == pytest.approx(closes[-1] * 1.001 ** 21, rel=1e-3)


def test_trend_projection_needs_enough_points():
    assert forecast.trend_projection([100, 101, 102]) == {}


def test_trend_flags_weak_fit_on_noise():
    t = forecast.trend_projection(zigzag(100, 8, 120))
    assert t["fit_quality"] == "weak"
    assert t["r_squared"] < 0.4


# --- probability bands -----------------------------------------------------
def test_bands_are_ordered_and_widen_with_horizon():
    closes = wobbly(100, 0.0005, 300)
    b = forecast.probability_bands(closes)
    for label, band in b["bands"].items():
        assert band["p5"] < band["p25"] < band["p50"] < band["p75"] < band["p95"], label
    # Uncertainty must grow with time.
    assert b["bands"]["1Y"]["expected_move_pct"] > b["bands"]["1W"]["expected_move_pct"]


def test_drift_is_shrunk_not_extrapolated_raw():
    """A hot run must not project at its full trailing rate."""
    closes = wobbly(100, 0.004, 300)
    b = forecast.probability_bands(closes)
    implied = (b["bands"]["1Y"]["p50"] / closes[-1] - 1) * 100
    assert 0 < implied < b["raw_annualized_drift_pct"]


def test_bands_need_enough_returns():
    assert forecast.probability_bands([100, 101]) == {}


# --- probability of touch --------------------------------------------------
def test_touch_probability_is_bounded_and_monotone():
    closes = wobbly(100, 0.0002, 300)
    last = closes[-1]
    near = forecast.probability_of_touch(closes, last * 1.02, 21)
    far = forecast.probability_of_touch(closes, last * 1.40, 21)
    assert 0 <= far["probability_pct"] <= near["probability_pct"] <= 100
    assert near["direction"] == "above"


def test_touch_probability_exceeds_terminal_probability():
    """First passage must be at least as likely as finishing beyond the level."""
    closes = wobbly(100, 0.0, 400)
    last = closes[-1]
    touch = forecast.probability_of_touch(closes, last * 1.05, 63)["probability_pct"]
    bands = forecast.probability_bands(closes, {"H": 63})["bands"]["H"]
    # p75 above the target would mean >25% chance of ENDING above it.
    terminal_above = 100 - 75 if bands["p75"] > last * 1.05 else 0
    assert touch >= terminal_above


def test_touch_handles_downside_barrier():
    closes = wobbly(100, 0.0, 300)
    r = forecast.probability_of_touch(closes, closes[-1] * 0.9, 21)
    assert r["direction"] == "below"
    assert 0 <= r["probability_pct"] <= 100


# --- signal score ----------------------------------------------------------
def test_signal_score_bullish_on_steady_climb():
    closes = wobbly(50, 0.002, 250)
    s = forecast.signal_score(closes, [1e6] * 250)
    assert s["score"] > 0
    assert s["label"] in ("bullish", "strong-bullish")
    assert set(s["factors"]) >= {"trend", "momentum", "macd"}


def test_signal_score_bearish_on_steady_decline():
    closes = wobbly(200, -0.002, 250)
    s = forecast.signal_score(closes, [1e6] * 250)
    assert s["score"] < 0
    assert s["label"] in ("bearish", "strong-bearish")


def test_signal_score_stays_in_range():
    for rate in (-0.02, -0.005, 0.0, 0.005, 0.02):
        s = forecast.signal_score(wobbly(100, rate, 260), [1e6] * 260)
        assert -100 <= s["score"] <= 100


def test_signal_score_needs_history():
    assert forecast.signal_score([100] * 10) == {}


def test_every_factor_carries_an_explanation():
    s = forecast.signal_score(wobbly(100, 0.001, 260), [1e6] * 260)
    for name, f in s["factors"].items():
        assert f["note"], f"{name} has no explanation"
        assert -1 <= f["score"] <= 1


# --- risk metrics ----------------------------------------------------------
def test_risk_metrics_on_flat_series():
    r = forecast.risk_metrics([100.0] * 100)
    assert r["annualized_volatility_pct"] == pytest.approx(0.0)
    assert r["positive_days_pct"] == 0.0
    assert r["sharpe"] is None          # no volatility to divide by


def test_sharpe_positive_for_strong_low_vol_growth():
    r = forecast.risk_metrics(wobbly(100, 0.001, 300))
    assert r["annualized_return_pct"] > 4
    assert r["sharpe"] is None or r["sharpe"] > 0


def test_var_is_worse_than_cvar_tail():
    closes = zigzag(100, 5, 200)
    r = forecast.risk_metrics(closes)
    # CVaR averages the tail beyond VaR, so it can't be less severe.
    assert r["cvar_95_pct"] <= r["var_95_pct"]
    assert r["worst_day_pct"] <= r["var_95_pct"]


# --- support / resistance --------------------------------------------------
def test_support_resistance_splits_around_price():
    n = 120
    close = [100 + 10 * math.sin(i / 6) for i in range(n)]
    high = [c + 1 for c in close]
    low = [c - 1 for c in close]
    lv = forecast.support_resistance(high, low, close)
    for r in lv["resistance"]:
        assert r["price"] > lv["current"]
        assert r["distance_pct"] > 0
    for s in lv["support"]:
        assert s["price"] < lv["current"]
        assert s["distance_pct"] < 0


def test_support_resistance_needs_enough_bars():
    assert forecast.support_resistance([1, 2], [1, 2], [1, 2]) == {}


def test_repeated_level_accumulates_touches():
    # Flat-topped range: the same high recurs, so it should cluster.
    close, high, low = [], [], []
    for i in range(120):
        c = 100 if i % 10 < 5 else 90
        close.append(c)
        high.append(c + 0.5)
        low.append(c - 0.5)
    lv = forecast.support_resistance(high, low, close)
    assert lv  # produced levels at all
    touches = [l["touches"] for l in lv["resistance"] + lv["support"]]
    assert touches and max(touches) >= 2


# --- bundle ----------------------------------------------------------------
def test_forecast_bundle_shape():
    n = 260
    close = wobbly(100, 0.001, n)
    high = [c * 1.01 for c in close]
    low = [c * 0.99 for c in close]
    dates = [f"2026-01-{(i % 28) + 1:02d}" for i in range(n)]
    out = forecast.forecast("test", dates, close, high, low, close, [1e6] * n)
    assert out["symbol"] == "TEST"
    assert out["points"] == n
    assert out["current_price"] == pytest.approx(round(close[-1], 2))
    for key in ("trend", "bands", "signal", "risk", "levels"):
        assert key in out


def test_forecast_survives_short_series():
    """A brand-new listing shouldn't crash the endpoint, just return less."""
    out = forecast.forecast("new", ["2026-01-01"] * 3, [1, 2, 3], [1, 2, 3],
                            [1, 2, 3], [1, 2, 3], [10, 10, 10])
    assert out["symbol"] == "NEW"
    assert out["trend"] == {} and out["signal"] == {}
