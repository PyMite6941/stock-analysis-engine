"""Portfolio-level risk: concentration, clusters, and weighted stats."""
import math
import random
from datetime import date, timedelta

import pytest

from core import risk


START = date(2026, 1, 1)


def series(n=160, drift=0.0004, vol=0.012, seed=1, base=100.0):
    """A synthetic price path — deterministic, so the assertions are stable.

    Dates must be REAL calendar dates: align_series sorts them as strings, so a
    made-up "2026-01-100" would sort before "2026-01-11" and scramble the
    series into something far more volatile than the path actually is.
    """
    rnd = random.Random(seed)
    closes, p = [], base
    for _ in range(n):
        p *= math.exp(drift + rnd.gauss(0, vol))
        closes.append(round(p, 4))
    dates = [(START + timedelta(days=i)).isoformat() for i in range(n)]
    return {"dates": dates, "closes": closes}


def valued(weights_by_value: dict):
    """Minimal value_portfolio-shaped dict."""
    rows = [{"symbol": s, "market_value": v, "cost": v, "pnl": 0.0}
            for s, v in weights_by_value.items()]
    total = sum(weights_by_value.values())
    return {"positions": rows,
            "summary": {"total_value": total, "n_unpriced": 0}}


# ---------------------------------------------------------------------------
# Weights and concentration
# ---------------------------------------------------------------------------
def test_weights_are_of_market_value():
    w = risk.weights_from(valued({"A": 75.0, "B": 25.0}))
    assert w == pytest.approx({"A": 0.75, "B": 0.25})


def test_lots_of_the_same_symbol_are_combined():
    v = {"positions": [
        {"symbol": "A", "market_value": 30.0},
        {"symbol": "A", "market_value": 30.0},
        {"symbol": "B", "market_value": 40.0}], "summary": {}}
    assert risk.weights_from(v)["A"] == pytest.approx(0.6)


def test_unpriced_rows_are_excluded_from_weights():
    v = {"positions": [
        {"symbol": "A", "market_value": 100.0},
        {"symbol": "GHOST", "market_value": None}], "summary": {}}
    w = risk.weights_from(v)
    assert "GHOST" not in w
    assert w["A"] == pytest.approx(1.0)


def test_equal_weights_give_hhi_of_one_over_n():
    c = risk.concentration({"A": 0.25, "B": 0.25, "C": 0.25, "D": 0.25})
    assert c["hhi"] == pytest.approx(0.25)
    assert c["effective_positions"] == pytest.approx(4.0)
    assert c["concentrated"] is True        # HHI exactly at the threshold


def test_a_dominant_position_is_flagged():
    c = risk.concentration({"NVDA": 0.8, "A": 0.1, "B": 0.1})
    assert c["largest"] == {"symbol": "NVDA", "weight_pct": 80.0}
    assert c["concentrated"] is True
    assert c["effective_positions"] < 2


def test_a_spread_book_is_not_flagged():
    w = {f"S{i}": 0.1 for i in range(10)}
    c = risk.concentration(w)
    assert c["concentrated"] is False
    assert c["effective_positions"] == pytest.approx(10.0)


def test_top3_weight():
    c = risk.concentration({"A": 0.4, "B": 0.3, "C": 0.2, "D": 0.1})
    assert c["top3_weight_pct"] == pytest.approx(90.0)


def test_empty_weights_are_unavailable_not_a_crash():
    assert risk.concentration({})["available"] is False


# ---------------------------------------------------------------------------
# Clusters
# ---------------------------------------------------------------------------
def test_identical_series_cluster_together():
    base = series(seed=7)
    hist = {"A": base, "B": dict(base), "C": series(seed=99)}
    groups = risk.clusters(hist)
    assert any(set(g) >= {"A", "B"} for g in groups)


def test_uncorrelated_series_do_not_cluster():
    hist = {s: series(seed=i) for i, s in enumerate("ABC", start=1)}
    assert risk.clusters(hist) == []


def test_single_symbol_has_no_clusters():
    assert risk.clusters({"A": series()}) == []


def test_short_history_returns_no_clusters():
    short = {"dates": ["2026-01-01", "2026-01-02"], "closes": [10.0, 11.0]}
    assert risk.clusters({"A": short, "B": dict(short)}) == []


# ---------------------------------------------------------------------------
# Portfolio series and stats
# ---------------------------------------------------------------------------
def test_one_holding_portfolio_matches_that_holding():
    hist = {"A": series(seed=3)}
    _, rets = risk.portfolio_series(hist, {"A": 1.0})
    from core.stats_util import log_returns
    assert rets == pytest.approx(log_returns(hist["A"]["closes"]))


def test_weighted_series_sits_between_its_holdings():
    a, b = series(seed=3, drift=0.002), series(seed=4, drift=-0.001)
    _, ra = risk.portfolio_series({"A": a}, {"A": 1.0})
    _, rb = risk.portfolio_series({"B": b}, {"B": 1.0})
    _, mix = risk.portfolio_series({"A": a, "B": b}, {"A": 0.5, "B": 0.5})
    assert min(sum(ra), sum(rb)) <= sum(mix) <= max(sum(ra), sum(rb))


def test_diversifying_lowers_volatility():
    """Two uncorrelated holdings are less volatile together than apart."""
    a, b = series(seed=11), series(seed=12)
    _, ra = risk.portfolio_series({"A": a}, {"A": 1.0})
    _, mix = risk.portfolio_series({"A": a, "B": b}, {"A": 0.5, "B": 0.5})
    assert risk.risk_stats(mix)["annual_volatility_pct"] \
        < risk.risk_stats(ra)["annual_volatility_pct"]


def test_stats_need_enough_history():
    assert risk.risk_stats([0.001] * 10)["available"] is False


def test_drawdown_is_negative_or_zero():
    stats = risk.risk_stats(risk.portfolio_series(
        {"A": series(seed=5)}, {"A": 1.0})[1])
    assert stats["max_drawdown_pct"] <= 0


def test_monotonic_rise_has_no_drawdown():
    rets = [0.001] * 60
    assert risk.risk_stats(rets)["max_drawdown_pct"] == 0.0


def test_var_is_worse_than_cvar_is_not_true_the_other_way():
    """CVaR averages the tail beyond VaR, so it is always the worse number."""
    stats = risk.risk_stats(risk.portfolio_series(
        {"A": series(seed=21)}, {"A": 1.0})[1])
    assert stats["cvar_95_pct"] <= stats["var_95_pct"]


def test_empty_history_gives_empty_series():
    assert risk.portfolio_series({}, {}) == ([], [])


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------
def test_portfolio_risk_assembles_every_section():
    hist = {"A": series(seed=31), "B": series(seed=32)}
    out = risk.portfolio_risk(valued({"A": 6000.0, "B": 4000.0}), hist)
    assert out["concentration"]["available"] is True
    assert out["portfolio"]["available"] is True
    assert isinstance(out["verdict"], str) and out["verdict"]
    assert out["total_value"] == 10000.0


def test_verdict_names_the_dominant_holding():
    hist = {"A": series(seed=41), "B": series(seed=42)}
    out = risk.portfolio_risk(valued({"A": 9000.0, "B": 1000.0}), hist)
    assert "A is 90% of the book" in out["verdict"]


def test_verdict_names_a_correlated_cluster():
    base = series(seed=51)
    hist = {"A": base, "B": dict(base)}
    out = risk.portfolio_risk(valued({"A": 5000.0, "B": 5000.0}), hist)
    assert "move together" in out["verdict"]


def test_single_holding_degrades_gracefully():
    out = risk.portfolio_risk(valued({"A": 1000.0}), {"A": series(seed=61)})
    assert out["correlation"]["available"] is False
    assert out["clusters"] == []
    assert out["portfolio"]["available"] is True     # one holding still has risk
