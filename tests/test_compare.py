"""Period comparison: stock return vs holder return. No network."""

import pytest

from core import compare, positions


class FakeQuote:
    def __init__(self, symbol, price, change=0.0):
        self.symbol = symbol
        self.price = price
        self.change = change


def hist(dates, closes):
    return {"dates": dates, "closes": closes}


DATES = ["2026-03-16", "2026-06-16", "2026-09-16"]


def test_stock_return_and_holder_return_can_disagree():
    """The central case: the share price rose over the window, but someone who
    bought above today's price is still down."""
    parsed = positions.parse_positions(
        [{"symbol": "AAPL", "shares": 10, "cost_basis": 400.0, "opened": "2025-01-15"}])
    histories = {"AAPL": hist(DATES, [252.0, 300.0, 331.34])}
    out = compare.compare_positions(parsed, histories, [FakeQuote("AAPL", 331.34)])

    row = out["positions"][0]
    assert row["period_change_pct"] == pytest.approx(31.48, abs=0.05)   # stock up
    assert row["pnl_pct"] == pytest.approx(-17.17, abs=0.05)            # holder down
    assert row["held_full_period"] is True


def test_partial_period_measures_from_purchase_date():
    """A lot bought mid-window must not be credited with the whole period."""
    parsed = positions.parse_positions(
        [{"symbol": "NVDA", "shares": 400, "cost_basis": 178.50,
          "opened": "2026-06-16"}])
    histories = {"NVDA": hist(DATES, [100.0, 200.0, 212.17])}
    out = compare.compare_positions(parsed, histories, [FakeQuote("NVDA", 212.17)])

    row = out["positions"][0]
    assert row["held_full_period"] is False
    assert row["period_start_date"] == "2026-06-16"
    # From 200 -> 212.17, not from 100.
    assert row["period_start_price"] == pytest.approx(200.0)
    assert row["period_change_pct"] == pytest.approx(6.09, abs=0.05)
    assert out["summary"]["partial_period_holdings"] == 1


def test_position_with_no_open_date_counts_as_full_period():
    parsed = positions.parse_positions(
        [{"symbol": "MSFT", "shares": 25, "cost_basis": 412.30}])
    histories = {"MSFT": hist(DATES, [400.0, 450.0, 500.0])}
    out = compare.compare_positions(parsed, histories, [FakeQuote("MSFT", 500.0)])
    assert out["positions"][0]["held_full_period"] is True
    assert out["positions"][0]["period_change_pct"] == pytest.approx(25.0)


def test_portfolio_totals_and_ranking():
    parsed = positions.parse_positions([
        {"symbol": "WIN", "shares": 10, "cost_basis": 50.0, "opened": "2020-01-01"},
        {"symbol": "LOSE", "shares": 10, "cost_basis": 50.0, "opened": "2020-01-01"},
    ])
    histories = {
        "WIN": hist(DATES, [100.0, 110.0, 120.0]),    # +20%
        "LOSE": hist(DATES, [100.0, 90.0, 80.0]),     # -20%
    }
    out = compare.compare_positions(
        parsed, histories, [FakeQuote("WIN", 120.0), FakeQuote("LOSE", 80.0)])
    s = out["summary"]

    assert s["gainers"] == 1 and s["losers"] == 1
    assert s["start_value"] == pytest.approx(2000.0)   # 10*100 + 10*100
    assert s["end_value"] == pytest.approx(2000.0)     # 10*120 + 10*80
    assert s["period_change_pct"] == pytest.approx(0.0)
    # Sorted best-first.
    assert out["positions"][0]["symbol"] == "WIN"
    assert s["best"]["symbol"] == "WIN"
    assert s["worst"]["symbol"] == "LOSE"


def test_period_dollars_use_current_share_count():
    parsed = positions.parse_positions(
        [{"symbol": "X", "shares": 400, "cost_basis": 1.0, "opened": "2020-01-01"}])
    histories = {"X": hist(DATES, [100.0, 105.0, 110.0])}
    out = compare.compare_positions(parsed, histories, [FakeQuote("X", 110.0)])
    # 400 shares x (110 - 100)
    assert out["positions"][0]["period_change"] == pytest.approx(4000.0)


def test_benchmark_comparison_flags_ahead_and_behind():
    parsed = positions.parse_positions(
        [{"symbol": "X", "shares": 1, "cost_basis": 100.0, "opened": "2020-01-01"}])
    histories = {"X": hist(DATES, [100.0, 100.0, 105.0])}       # +5%
    bench = {"symbol": "SPY", "dates": DATES, "closes": [100.0, 110.0, 120.0]}  # +20%

    out = compare.compare_positions(parsed, histories, [FakeQuote("X", 105.0)],
                                    benchmark=bench)
    b = out["benchmark"]
    assert b["period_change_pct"] == pytest.approx(20.0)
    assert b["verdict"] == "behind"
    assert b["excess_pct"] == pytest.approx(-15.0)

    # Same book against a flat market is now ahead.
    flat = {"symbol": "SPY", "dates": DATES, "closes": [100.0, 100.0, 100.0]}
    out2 = compare.compare_positions(parsed, histories, [FakeQuote("X", 105.0)],
                                     benchmark=flat)
    assert out2["benchmark"]["verdict"] == "ahead"


def test_multiple_lots_of_one_symbol_are_combined():
    parsed = positions.parse_positions([
        {"symbol": "NVDA", "shares": 400, "cost_basis": 178.50, "opened": "2026-01-01"},
        {"symbol": "NVDA", "shares": 50, "cost_basis": 205.00, "opened": "2026-08-01"},
    ])
    histories = {"NVDA": hist(DATES, [150.0, 200.0, 212.17])}
    out = compare.compare_positions(parsed, histories, [FakeQuote("NVDA", 212.17)])
    assert len(out["positions"]) == 1
    assert out["positions"][0]["shares"] == 450
    # Earliest lot predates the window, so the symbol counts as fully held.
    assert out["positions"][0]["held_full_period"] is True


def test_missing_history_does_not_break_the_roll_up():
    parsed = positions.parse_positions([
        {"symbol": "GOOD", "shares": 1, "cost_basis": 10.0, "opened": "2020-01-01"},
        {"symbol": "NOHIST", "shares": 1, "cost_basis": 10.0, "opened": "2020-01-01"},
    ])
    histories = {"GOOD": hist(DATES, [10.0, 12.0, 15.0])}
    out = compare.compare_positions(
        parsed, histories, [FakeQuote("GOOD", 15.0), FakeQuote("NOHIST", 20.0)])
    by_sym = {r["symbol"]: r for r in out["positions"]}
    assert by_sym["NOHIST"]["period_change_pct"] is None
    assert by_sym["GOOD"]["period_change_pct"] == pytest.approx(50.0)
    # Totals only count what could be priced over the window.
    assert out["summary"]["start_value"] == pytest.approx(10.0)


def test_csv_export_columns_present():
    parsed = positions.parse_positions(
        [{"symbol": "X", "shares": 1, "cost_basis": 10.0, "opened": "2020-01-01"}])
    out = compare.compare_positions(parsed, {"X": hist(DATES, [10.0, 11.0, 12.0])},
                                    [FakeQuote("X", 12.0)])
    rows = compare.to_csv_rows(out["positions"])
    assert rows[0] == compare.COMPARE_COLUMNS
    assert rows[1][0] == "X"
    assert len(rows) == 2
