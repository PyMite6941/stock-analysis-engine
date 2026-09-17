"""Regressions for crashes found by fuzzing the maths with degenerate inputs.

Real feeds do produce these: a halted or delisted ticker can return a run of
zeros, and a corrupt bar can carry an infinity. None of it should take down an
endpoint.
"""

import math

import pytest

from core import backtest, daytrade, forecast, indicators, metrics
from core.stats_util import log_returns

ZEROS = [0.0] * 60
INF_SERIES = [100.0, float("inf")] + [100.0] * 60
NAN_SERIES = [100.0, float("nan")] + [100.0] * 60
FLAT = [100.0] * 300


# --- log_returns is the shared choke point ---------------------------------
def test_log_returns_rejects_infinity():
    """inf > 0 is True, so it slipped the positivity check; then 100/inf == 0.0
    and math.log(0.0) raised ValueError."""
    out = log_returns(INF_SERIES)
    assert all(math.isfinite(r) for r in out)


def test_log_returns_rejects_nan():
    assert all(math.isfinite(r) for r in log_returns(NAN_SERIES))


def test_log_returns_skips_zero_and_negative():
    assert log_returns([0.0, 100.0, -5.0, 100.0]) == []


# --- the four functions that crashed on an infinite bar --------------------
@pytest.mark.parametrize("series", [INF_SERIES, NAN_SERIES, ZEROS, FLAT, [], [1.0]])
def test_probability_bands_never_raises(series):
    forecast.probability_bands(series)


@pytest.mark.parametrize("series", [INF_SERIES, NAN_SERIES, ZEROS, FLAT, [], [1.0]])
def test_risk_metrics_never_raises(series):
    forecast.risk_metrics(series)


@pytest.mark.parametrize("series", [INF_SERIES, NAN_SERIES, ZEROS, FLAT, [], [1.0]])
def test_probability_of_touch_never_raises(series):
    forecast.probability_of_touch(series, 110.0, 21)


@pytest.mark.parametrize("series", [INF_SERIES, NAN_SERIES, ZEROS, FLAT, [], [1.0]])
def test_trend_projection_never_raises(series):
    out = forecast.trend_projection(series)
    # An infinite bar used to poison the fit into NaN and pass silently.
    if out:
        assert math.isfinite(out["r_squared"])
        assert all(math.isfinite(v) for v in out["projections"].values())


# --- support/resistance divided by a zero price ----------------------------
def test_support_resistance_survives_an_all_zero_series():
    """A halted ticker can come back as zeros; this raised ZeroDivisionError."""
    assert forecast.support_resistance(ZEROS, ZEROS, ZEROS) == {}


def test_support_resistance_survives_infinite_pivots():
    n = 60
    close = [100.0] * n
    high = [float("inf")] * n
    forecast.support_resistance(high, [99.0] * n, close)      # must not raise


def test_support_resistance_still_works_normally():
    n = 120
    close = [100 + 10 * math.sin(i / 6) for i in range(n)]
    lv = forecast.support_resistance([c + 1 for c in close],
                                     [c - 1 for c in close], close)
    assert lv["resistance"] or lv["support"]


# --- everything else that touches a price series ---------------------------
@pytest.mark.parametrize("series", [INF_SERIES, NAN_SERIES, ZEROS, FLAT, [], [1.0]])
def test_signal_score_never_raises(series):
    forecast.signal_score(series, [1e6] * len(series))


@pytest.mark.parametrize("series", [INF_SERIES, NAN_SERIES, ZEROS, FLAT, [], [1.0]])
def test_indicators_never_raise(series):
    indicators.compute_all(series)


@pytest.mark.parametrize("series", [INF_SERIES, NAN_SERIES, ZEROS, FLAT, [], [1.0]])
def test_backtest_never_raises(series):
    backtest.backtest_signal(series, [1e6] * len(series))


@pytest.mark.parametrize("series", [INF_SERIES, ZEROS, FLAT, [1.0]])
def test_daytrade_helpers_never_raise(series):
    n = len(series)
    daytrade.atr([x + 1 for x in series], [x - 1 for x in series], series)
    daytrade.intraday_volatility(series)
    if n:
        daytrade.session_stats(series, [x + 1 for x in series],
                               [x - 1 for x in series], series, [1e6] * n)


@pytest.mark.parametrize("series", [INF_SERIES, ZEROS, FLAT, []])
def test_metrics_never_raise(series):
    hist = type("H", (), {"symbol": "X", "closes": series})()
    metrics.analyze_history(hist)


# --- sizing / pivot arithmetic --------------------------------------------
@pytest.mark.parametrize("args", [
    (0, 0, 0, 0), (10000, 1, 100, 100), (-1, 1, 100, 90), (10000, 1, 100, -5),
])
def test_position_size_rejects_nonsense_without_raising(args):
    daytrade.position_size(*args)


@pytest.mark.parametrize("args", [(0, 0, 0), (1e12, -1e12, 0), (100, 100, 100)])
def test_pivot_points_never_raises(args):
    daytrade.pivot_points(*args)
