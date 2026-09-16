"""Lot matching, holding periods and realised gains. No network."""

from datetime import date

import pytest

from core import positions, realized


def lots(*specs):
    """specs: (symbol, shares, cost_basis, opened, id)"""
    return positions.parse_positions([
        {"symbol": s, "shares": sh, "cost_basis": cb, "opened": op, "id": lid}
        for s, sh, cb, op, lid in specs])


# --- timestamp parsing -----------------------------------------------------
def test_accepts_date_only_and_date_with_time():
    assert realized._to_datetime("2026-09-16").year == 2026
    assert realized._to_datetime("2026-09-16 14:20").hour == 14
    assert realized._to_datetime("2026-09-16T14:20").minute == 20
    assert realized._to_datetime("2026-09-16 14:20:35").second == 35
    assert realized._to_datetime("nonsense") is None
    assert realized._to_datetime(None) is None


def test_has_time_detects_a_clock():
    assert realized.has_time("2026-09-16 09:45")
    assert not realized.has_time("2026-09-16")
    # Midnight is a real trade time, so the string decides, not the value.
    assert realized.has_time("2026-09-16 00:00")


def test_holding_days_uses_the_date_part():
    assert realized.holding_days("2026-01-01", "2026-09-16") == 258
    assert realized.holding_days("2026-09-16 09:45", "2026-09-16 14:20") == 0
    assert realized.holding_days(None, "2026-09-16") is None


def test_holding_minutes_needs_both_times():
    assert realized.holding_minutes("2026-09-16 09:45", "2026-09-16 14:20") == 275.0
    # One side date-only would invent a midnight; refuse instead.
    assert realized.holding_minutes("2026-09-16", "2026-09-16 14:20") is None
    assert realized.holding_minutes("2026-01-01", "2026-09-16") is None


def test_duration_label():
    assert realized.format_duration(45.0, 0) == "45m"
    assert realized.format_duration(275.0, 0) == "4.6h"
    assert realized.format_duration(None, 15) == "15d"
    assert realized.format_duration(None, 430) == "1.2y"
    assert realized.format_duration(None, None) is None


def test_term_boundary_is_more_than_a_year():
    assert realized.term_for(365) == "short"
    assert realized.term_for(366) == "long"
    assert realized.term_for(None) == "unknown"


def test_days_to_long_term_counts_down():
    assert realized.days_to_long_term("2026-01-01", date(2026, 9, 16)) == 108
    assert realized.days_to_long_term("2020-01-01", date(2026, 9, 16)) == 0
    assert realized.days_to_long_term(None) is None


# --- matching --------------------------------------------------------------
def test_fifo_takes_the_oldest_lot_first():
    book = lots(("NVDA", 400, 178.50, "2026-09-01", "l1"),
                ("NVDA", 50, 205.00, "2026-09-15", "l2"))
    out = realized.match_sale(book, "NVDA", 100, 212.17, "2026-09-16", realized.FIFO)
    assert len(out["realized"]) == 1
    assert out["realized"][0]["opened"] == "2026-09-01"
    assert out["realized"][0]["pnl"] == pytest.approx(3367.0)
    assert out["unmatched"] == 0


def test_lifo_takes_the_newest_lot_first():
    book = lots(("NVDA", 400, 178.50, "2026-09-01", "l1"),
                ("NVDA", 50, 205.00, "2026-09-15", "l2"))
    out = realized.match_sale(book, "NVDA", 100, 212.17, "2026-09-16", realized.LIFO)
    assert out["realized"][0]["opened"] == "2026-09-15"
    assert out["realized"][0]["shares"] == 50
    # Spills into the older lot for the remaining 50.
    assert out["realized"][1]["opened"] == "2026-09-01"
    assert sum(r["shares"] for r in out["realized"]) == 100


def test_specific_lot_selection_is_honoured():
    book = lots(("NVDA", 400, 178.50, "2026-09-01", "l1"),
                ("NVDA", 50, 205.00, "2026-09-15", "l2"))
    out = realized.match_sale(book, "NVDA", 50, 212.17, "2026-09-16",
                              realized.SPECIFIC, lot_ids=["l2"])
    assert out["realized"][0]["lot_id"] == "l2"
    assert out["realized"][0]["cost_basis"] == 205.00


def test_partial_lot_leaves_the_remainder_open():
    book = lots(("NVDA", 400, 178.50, "2026-09-01", "l1"))
    out = realized.match_sale(book, "NVDA", 100, 212.17, "2026-09-16")
    left = [l for l in out["remaining_lots"] if l.symbol == "NVDA"]
    assert len(left) == 1
    assert left[0].shares == pytest.approx(300)
    assert left[0].cost_basis == 178.50      # unchanged basis on the remainder


def test_selling_everything_closes_the_position():
    book = lots(("NVDA", 400, 178.50, "2026-09-01", "l1"))
    out = realized.match_sale(book, "NVDA", 400, 212.17, "2026-09-16")
    assert [l for l in out["remaining_lots"] if l.symbol == "NVDA"] == []


def test_other_symbols_are_untouched():
    book = lots(("NVDA", 400, 178.50, "2026-09-01", "l1"),
                ("AAPL", 10, 400.0, "2025-01-15", "l2"))
    out = realized.match_sale(book, "NVDA", 400, 212.17, "2026-09-16")
    assert {l.symbol for l in out["remaining_lots"]} == {"AAPL"}


def test_overselling_is_reported_not_raised():
    book = lots(("NVDA", 100, 178.50, "2026-09-01", "l1"))
    out = realized.match_sale(book, "NVDA", 250, 212.17, "2026-09-16")
    assert out["unmatched"] == pytest.approx(150)
    assert sum(r["shares"] for r in out["realized"]) == pytest.approx(100)


def test_nothing_held_returns_no_rows():
    out = realized.match_sale(lots(("AAPL", 1, 1, None, "x")), "NVDA", 1, 1)
    assert out["realized"] == []


def test_rejects_nonsense_sale():
    out = realized.match_sale(lots(("NVDA", 1, 1, None, "x")), "NVDA", 0, 10)
    assert out["realized"] == [] and "error" in out


def test_undated_lots_sort_last_under_fifo():
    """A missing date must not silently claim long-term treatment."""
    book = lots(("NVDA", 10, 100.0, None, "undated"),
                ("NVDA", 10, 100.0, "2020-01-01", "old"))
    out = realized.match_sale(book, "NVDA", 10, 150.0, "2026-09-16", realized.FIFO)
    assert out["realized"][0]["lot_id"] == "old"
    assert out["realized"][0]["term"] == "long"


def test_intraday_round_trip_is_flagged():
    book = lots(("TSLA", 50, 180.0, "2026-09-16 09:45", "d1"))
    out = realized.match_sale(book, "TSLA", 50, 184.5, "2026-09-16 11:20")
    row = out["realized"][0]
    assert row["intraday"] is True
    assert row["holding_minutes"] == pytest.approx(95.0)
    assert row["holding_label"] == "1.6h"
    assert row["term"] == "short"
    assert row["pnl"] == pytest.approx(225.0)


def test_input_lots_are_not_mutated():
    book = lots(("NVDA", 400, 178.50, "2026-09-01", "l1"))
    realized.match_sale(book, "NVDA", 100, 212.17, "2026-09-16")
    assert book[0].shares == 400


# --- reporting -------------------------------------------------------------
SALES = [
    {"symbol": "NVDA", "shares": 100, "cost_basis": 178.50, "exit_price": 212.17,
     "opened": "2026-09-01", "closed": "2026-09-16"},                 # short
    {"symbol": "AAPL", "shares": 5, "cost_basis": 150.0, "exit_price": 331.0,
     "opened": "2023-01-10", "closed": "2026-02-01"},                 # long
    {"symbol": "TSLA", "shares": 50, "cost_basis": 190.0, "exit_price": 180.0,
     "opened": "2026-09-16 09:45", "closed": "2026-09-16 11:20"},     # intraday loss
]


def test_parse_sales_drops_unusable_rows():
    parsed = realized.parse_sales(SALES + [{"symbol": "X"}, None,
                                           {"symbol": "Y", "shares": -1,
                                            "cost_basis": 1, "exit_price": 1}])
    assert len(parsed) == 3


def test_summary_splits_short_and_long_term():
    s = realized.realized_summary(realized.parse_sales(SALES))
    assert s["n_sales"] == 3
    assert s["n_short_term"] == 2 and s["n_long_term"] == 1
    assert s["long_term_pnl"] == pytest.approx(905.0)
    assert s["short_term_pnl"] == pytest.approx(3367.0 - 500.0)
    assert s["total_pnl"] == pytest.approx(3367.0 - 500.0 + 905.0)
    assert s["wins"] == 2 and s["losses"] == 1
    assert s["win_rate_pct"] == pytest.approx(66.7, abs=0.1)
    assert s["best"]["symbol"] == "NVDA"
    assert s["worst"]["symbol"] == "TSLA"


def test_summary_counts_intraday_round_trips():
    s = realized.realized_summary(realized.parse_sales(SALES))
    assert s["n_intraday"] == 1
    assert s["intraday_pnl"] == pytest.approx(-500.0)


def test_summary_filters_by_year():
    parsed = realized.parse_sales(SALES)
    s = realized.realized_summary(parsed, year=2026)
    assert s["n_sales"] == 3
    assert realized.realized_summary(parsed, year=2019)["n_sales"] == 0


def test_empty_summary_is_safe():
    s = realized.realized_summary([])
    assert s["n_sales"] == 0 and s["total_pnl"] == 0.0 and s["best"] is None


def test_by_year_groups_newest_first():
    parsed = realized.parse_sales(SALES + [
        {"symbol": "OLD", "shares": 1, "cost_basis": 1.0, "exit_price": 2.0,
         "opened": "2024-01-01", "closed": "2025-06-01"}])
    years = realized.realized_by_year(parsed)
    assert [y["year"] for y in years] == [2026, 2025]


def test_lots_approaching_long_term():
    book = lots(("NVDA", 10, 100.0, "2025-10-01", "a"),     # 350 days held -> 16 to go
                ("AAPL", 10, 100.0, "2026-06-01", "b"),     # far off
                ("KO", 10, 100.0, "2020-01-01", "c"))       # already long
    out = realized.lots_approaching_long_term(book, as_of=date(2026, 9, 16))
    assert [r["symbol"] for r in out] == ["NVDA"]
    assert out[0]["days_to_long_term"] == 16


def test_csv_rows_have_headers_and_labels():
    rows = realized.to_csv_rows(realized.parse_sales(SALES))
    assert rows[0] == realized.CSV_COLUMNS
    assert "holding_label" in rows[0]
    assert len(rows) == 4
