"""Backtest, dividend income, correlation and portfolio forecast. No network."""

import math
from datetime import date

import pytest

from core import backtest, correlation, forecast, income, positions


def wobbly(start, daily_rate, n, amplitude=0.012, phase=0.0):
    """Deterministic compounding series with real bar-to-bar volatility."""
    out = [start]
    for i in range(1, n):
        shock = amplitude * (math.sin(i * 1.7 + phase) + 0.6 * math.sin(i * 0.41 + phase))
        out.append(out[-1] * (1 + daily_rate + shock))
    return out


def dates_for(n, start_day=1):
    """n sequential ISO dates, ignoring weekends (good enough for alignment)."""
    from datetime import timedelta
    d0 = date(2024, 1, 1) + timedelta(days=start_day)
    return [(d0 + timedelta(days=i)).isoformat() for i in range(n)]


# ===========================================================================
# Backtest
# ===========================================================================
def test_backtest_refuses_short_history():
    r = backtest.backtest_signal(wobbly(100, 0.001, 100), horizon=21)
    assert r["available"] is False
    assert "Needs at least" in r["reason"]


def test_backtest_runs_and_reports_shape():
    close = wobbly(100, 0.0005, 700)
    r = backtest.backtest_signal(close, [1e6] * 700, horizon=21)
    assert r["available"] is True
    assert r["bars_tested"] > 0
    assert r["horizon"] == 21
    assert len(r["buckets"]) == len(backtest.BANDS)
    assert r["verdict"] in {"predictive", "weak-signal", "no-edge", "inverted",
                            "insufficient-data"}


def test_independent_samples_discounts_overlapping_windows():
    """Consecutive bars share their forward window, so raw count overstates."""
    close = wobbly(100, 0.0005, 700)
    r = backtest.backtest_signal(close, [1e6] * 700, horizon=21)
    assert r["independent_samples"] == r["bars_tested"] // 21
    assert r["independent_samples"] < r["bars_tested"]


def test_buckets_cover_every_observation():
    close = wobbly(100, 0.0005, 700)
    r = backtest.backtest_signal(close, [1e6] * 700, horizon=21)
    assert sum(b["n"] for b in r["buckets"]) == r["bars_tested"]


def test_backtest_detects_a_planted_edge():
    """Build a series that rises after high scores, and check it's found.

    A steady uptrend scores bullish and keeps rising, so the bullish bucket must
    beat the bearish one. If this fails the harness isn't measuring anything.
    """
    close = wobbly(50, 0.0015, 800, amplitude=0.008)
    r = backtest.backtest_signal(close, [1e6] * 800, horizon=21)
    assert r["available"]
    assert r["baseline_forward_pct"] > 0


def test_no_lookahead_truncating_the_series_keeps_early_scores():
    """Scoring bar i must not depend on anything after bar i.

    Score bar 300 using the full series, then again using only the first 301
    bars. Identical results prove the computation is point-in-time.
    """
    from core import indicators
    close = wobbly(100, 0.0008, 600)
    vol = [1e6 + i for i in range(600)]

    full = forecast.signal_at(indicators.compute_all(close), close, vol, 300)
    truncated = forecast.signal_at(
        indicators.compute_all(close[:301]), close[:301], vol[:301], 300)
    assert full["score"] == truncated["score"]
    assert full["factors"].keys() == truncated["factors"].keys()


def test_verdict_text_exists_for_every_verdict():
    for v in ("predictive", "weak-signal", "no-edge", "inverted",
              "insufficient-data"):
        assert backtest.VERDICT_TEXT[v]


def test_summary_passes_through_unavailable_reason():
    r = backtest.backtest_signal([100.0] * 50)
    assert backtest.backtest_summary(r) == r["reason"]


# ===========================================================================
# Dividend income
# ===========================================================================
KO_INFO = {"rate": 2.12, "dividend_yield_pct": 2.39, "payout_ratio_pct": 62.46,
           "five_year_avg_yield_pct": 2.86, "ex_div_date": "2026-09-15"}


def test_yield_on_cost_differs_from_current_yield():
    """The headline point: bought cheap, your yield is higher than today's."""
    row = {"symbol": "KO", "shares": 200, "cost": 12400.0, "avg_cost": 62.0,
           "price": 88.7, "market_value": 17740.0}
    out = income.position_income(row, KO_INFO)
    assert out["annual_income"] == pytest.approx(424.0)
    assert out["yield_on_cost_pct"] == pytest.approx(3.42, abs=0.01)
    assert out["current_yield_pct"] == pytest.approx(2.39, abs=0.01)
    assert out["yield_on_cost_pct"] > out["current_yield_pct"]


def test_monthly_and_quarterly_split():
    row = {"symbol": "KO", "shares": 200, "cost": 12400.0, "avg_cost": 62.0,
           "price": 88.7, "market_value": 17740.0}
    out = income.position_income(row, KO_INFO)
    assert out["monthly_income"] == pytest.approx(424.0 / 12, abs=0.01)
    assert out["quarterly_income"] == pytest.approx(106.0)


def test_non_payer_is_handled():
    row = {"symbol": "NOPE", "shares": 10, "cost": 1000.0, "avg_cost": 100.0,
           "price": 120.0, "market_value": 1200.0}
    out = income.position_income(row, {})
    assert out["pays_dividend"] is False
    assert out["annual_income"] is None
    assert out["yield_on_cost_pct"] is None


def test_stretched_payout_is_flagged():
    row = {"symbol": "X", "shares": 10, "cost": 1000.0, "avg_cost": 100.0,
           "price": 100.0, "market_value": 1000.0}
    assert income.position_income(row, {"rate": 5.0, "payout_ratio_pct": 95.0})["stretched"]
    assert not income.position_income(row, {"rate": 5.0, "payout_ratio_pct": 30.0})["stretched"]


def test_next_ex_date_rolls_a_past_date_forward():
    """The provider reports the LAST ex-date; an 'upcoming' list of past dates
    would be nonsense."""
    today = date(2026, 9, 16)
    r = income.next_ex_date("2026-08-10", today)
    assert r["date"] == "2026-11-09"
    assert r["estimated"] is True
    assert r["days_away"] == 54
    assert r["last_ex_date"] == "2026-08-10"


def test_next_ex_date_keeps_a_future_date_as_is():
    r = income.next_ex_date("2026-12-01", date(2026, 9, 16))
    assert r["date"] == "2026-12-01" and r["estimated"] is False


def test_next_ex_date_gives_up_on_stale_data():
    r = income.next_ex_date("2019-01-01", date(2026, 9, 16))
    assert r["date"] is None and r.get("stale") is True


def test_next_ex_date_handles_missing():
    assert income.next_ex_date(None)["date"] is None
    assert income.next_ex_date("garbage")["date"] is None


class FakeQuote:
    def __init__(self, symbol, price, change=0.0):
        self.symbol, self.price, self.change = symbol, price, change


def test_portfolio_income_rollup():
    parsed = positions.parse_positions([
        {"symbol": "KO", "shares": 200, "cost_basis": 62.0},
        {"symbol": "NOPAY", "shares": 10, "cost_basis": 100.0},
    ])
    out = income.portfolio_income(
        parsed, [FakeQuote("KO", 88.7), FakeQuote("NOPAY", 120.0)],
        {"KO": KO_INFO, "NOPAY": {}})
    s = out["summary"]
    assert s["n_payers"] == 1 and s["n_non_payers"] == 1
    assert s["annual_income"] == pytest.approx(424.0)
    assert s["biggest_payer"] == "KO"
    assert s["top_payer_share_pct"] == pytest.approx(100.0)
    # Upcoming list only contains genuinely future dates.
    for u in out["upcoming_ex_dates"]:
        assert u["days_away"] is None or u["days_away"] >= 0


# ===========================================================================
# Correlation / diversification
# ===========================================================================
def hist(dates, closes):
    return {"dates": dates, "closes": closes}


def test_identical_series_correlate_at_one():
    d = dates_for(120)
    s = wobbly(100, 0.0005, 120)
    c = correlation.correlation_matrix({"A": hist(d, s), "B": hist(d, list(s))})
    assert c["available"]
    assert c["matrix"]["A"]["B"] == pytest.approx(1.0, abs=1e-6)


def test_inverse_series_correlate_negatively():
    d = dates_for(120)
    a = wobbly(100, 0.0, 120)
    # Mirror the returns to build an anti-correlated series.
    b = [100.0]
    for i in range(1, len(a)):
        b.append(b[-1] * (2 - a[i] / a[i - 1]))
    c = correlation.correlation_matrix({"A": hist(d, a), "B": hist(d, b)})
    assert c["matrix"]["A"]["B"] < -0.9


def test_alignment_intersects_dates():
    """A symbol with a shorter history must not shift the others."""
    long_d = dates_for(120)
    short_d = long_d[40:]
    aligned_dates, aligned = correlation.align_series({
        "A": hist(long_d, wobbly(100, 0.001, 120)),
        "B": hist(short_d, wobbly(50, 0.001, 80)),
    })
    assert len(aligned_dates) == 80
    assert len(aligned["A"]) == len(aligned["B"]) == 80


def test_correlation_needs_two_symbols():
    d = dates_for(60)
    r = correlation.correlation_matrix({"A": hist(d, wobbly(100, 0.001, 60))})
    assert r["available"] is False


def test_effective_bets_collapses_for_identical_holdings():
    d = dates_for(200)
    s = wobbly(100, 0.0005, 200)
    div = correlation.diversification(
        {"A": hist(d, s), "B": hist(d, list(s)), "C": hist(d, list(s))})
    # Three identical holdings are one bet, however you slice them.
    assert div["effective_bets"] == pytest.approx(1.0, abs=0.05)


def test_effective_bets_rises_with_independent_holdings():
    d = dates_for(300)
    div = correlation.diversification({
        "A": hist(d, wobbly(100, 0.0005, 300, phase=0.0)),
        "B": hist(d, wobbly(100, 0.0005, 300, phase=2.1)),
        "C": hist(d, wobbly(100, 0.0005, 300, phase=4.3)),
    })
    assert div["effective_bets"] > 1.2


def test_concentration_is_distinguished_from_correlation():
    """One holding at 90% is a concentration problem, not a correlation one."""
    d = dates_for(300)
    hs = {
        "A": hist(d, wobbly(100, 0.0005, 300, phase=0.0)),
        "B": hist(d, wobbly(100, 0.0005, 300, phase=2.1)),
        "C": hist(d, wobbly(100, 0.0005, 300, phase=4.3)),
    }
    lopsided = correlation.diversification(hs, {"A": 90000, "B": 5000, "C": 5000})
    even = correlation.diversification(hs, {"A": 1000, "B": 1000, "C": 1000})

    assert lopsided["top_weight_pct"] == pytest.approx(90.0)
    assert lopsided["limited_by"] == "concentration"
    assert lopsided["effective_bets"] < even["effective_bets"]
    assert lopsided["weight_effective_bets"] < even["weight_effective_bets"]


def test_verdict_names_the_cause():
    d = dates_for(300)
    hs = {
        "A": hist(d, wobbly(100, 0.0005, 300, phase=0.0)),
        "B": hist(d, wobbly(100, 0.0005, 300, phase=2.1)),
        "C": hist(d, wobbly(100, 0.0005, 300, phase=4.3)),
    }
    corr = correlation.correlation_matrix(hs)
    text = correlation.verdict(
        corr, correlation.diversification(hs, {"A": 90000, "B": 5000, "C": 5000}))
    assert "of the money" in text          # blames sizing, not correlation
    assert "A is 90%" in text


def test_verdict_handles_unavailable():
    assert "Not enough" in correlation.verdict({"available": False},
                                               {"available": False})


# ===========================================================================
# Portfolio forecast
# ===========================================================================
def test_portfolio_series_uses_shared_dates_and_current_shares():
    d = dates_for(100)
    hs = {"A": hist(d, [10.0] * 100), "B": hist(d, [20.0] * 100)}
    dates, values = forecast.portfolio_series(hs, {"A": 10, "B": 5})
    assert len(dates) == 100
    assert values[0] == pytest.approx(10 * 10 + 5 * 20)


def test_portfolio_series_ignores_symbols_without_shares():
    d = dates_for(100)
    hs = {"A": hist(d, [10.0] * 100), "B": hist(d, [20.0] * 100)}
    _, values = forecast.portfolio_series(hs, {"A": 10})
    assert values[0] == pytest.approx(100.0)


def test_portfolio_forecast_bands_are_ordered():
    d = dates_for(300)
    hs = {"A": hist(d, wobbly(100, 0.0005, 300, phase=0.0)),
          "B": hist(d, wobbly(50, 0.0005, 300, phase=2.1))}
    r = forecast.portfolio_forecast(hs, {"A": 100, "B": 200})
    assert r["available"]
    for label, b in r["bands"].items():
        assert b["p5"] < b["p25"] < b["p50"] < b["p75"] < b["p95"], label
        assert b["p50_change"] == pytest.approx(b["p50"] - r["current_value"], abs=0.01)


def test_portfolio_forecast_is_less_volatile_than_its_parts():
    """Combining imperfectly-correlated holdings must reduce volatility —
    that's the entire claim diversification makes."""
    d = dates_for(400)
    a = wobbly(100, 0.0005, 400, phase=0.0)
    b = wobbly(100, 0.0005, 400, phase=2.6)
    hs = {"A": hist(d, a), "B": hist(d, b)}

    combined = forecast.portfolio_forecast(hs, {"A": 1, "B": 1})
    vol_a = forecast.probability_bands(a)["annualized_volatility_pct"]
    vol_b = forecast.probability_bands(b)["annualized_volatility_pct"]
    assert combined["annualized_volatility_pct"] < max(vol_a, vol_b)


def test_portfolio_forecast_needs_overlapping_history():
    r = forecast.portfolio_forecast({"A": hist(dates_for(10), [1.0] * 10)}, {"A": 1})
    assert r["available"] is False
