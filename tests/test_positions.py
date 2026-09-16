"""Holdings valuation + spreadsheet round-trip. No network."""

import pytest

from backend import exports
from core import positions


class FakeQuote:
    """Stands in for core.data.Quote without importing the provider layer."""

    def __init__(self, symbol, price, change=0.0):
        self.symbol = symbol
        self.price = price
        self.change = change


# --- parsing ---------------------------------------------------------------
def test_parse_normalises_and_drops_junk():
    parsed = positions.parse_positions([
        {"symbol": " nvda ", "shares": "400", "cost_basis": "178.5"},
        {"symbol": "AAPL"},                       # missing numbers
        {"shares": 10, "cost_basis": 5},          # missing symbol
        {"symbol": "MSFT", "shares": 0, "cost_basis": 10},   # zero shares
        None,
    ])
    assert [p.symbol for p in parsed] == ["NVDA"]
    assert parsed[0].shares == 400.0
    assert parsed[0].cost_basis == 178.5


def test_parse_keeps_short_positions():
    parsed = positions.parse_positions(
        [{"symbol": "TSLA", "shares": -5, "cost_basis": 180}])
    assert parsed[0].shares == -5


# --- valuation -------------------------------------------------------------
def test_gain_is_measured_from_cost_basis():
    """The headline case: 400 shares bought at 178.50, now 212.17."""
    parsed = positions.parse_positions(
        [{"symbol": "NVDA", "shares": 400, "cost_basis": 178.50}])
    out = positions.value_portfolio(parsed, [FakeQuote("NVDA", 212.17, 1.21)])
    row = out["positions"][0]
    assert row["cost"] == pytest.approx(71400.0)
    assert row["market_value"] == pytest.approx(84868.0)
    assert row["pnl"] == pytest.approx(13468.0)
    assert row["pnl_pct"] == pytest.approx(18.86, abs=0.01)
    assert row["direction"] == "up"
    # Day P/L is the quote's move × shares, NOT the since-purchase gain.
    assert row["day_pnl"] == pytest.approx(484.0)


def test_loss_is_reported_negative():
    parsed = positions.parse_positions(
        [{"symbol": "AAPL", "shares": 10, "cost_basis": 400.0}])
    out = positions.value_portfolio(parsed, [FakeQuote("AAPL", 331.34, -1.74)])
    row = out["positions"][0]
    assert row["pnl"] == pytest.approx(-686.6)
    assert row["direction"] == "down"


def test_unpriced_symbol_still_listed():
    parsed = positions.parse_positions(
        [{"symbol": "WEIRD", "shares": 5, "cost_basis": 10}])
    out = positions.value_portfolio(parsed, [])
    assert out["positions"][0]["market_value"] is None
    assert out["positions"][0]["is_open"] is False
    assert out["summary"]["n_unpriced"] == 1


def test_summary_totals_and_weights():
    parsed = positions.parse_positions([
        {"symbol": "NVDA", "shares": 400, "cost_basis": 178.50},
        {"symbol": "AAPL", "shares": 10, "cost_basis": 400.0},
    ])
    out = positions.value_portfolio(
        parsed, [FakeQuote("NVDA", 212.17, 1.21), FakeQuote("AAPL", 331.34, -1.74)])
    s = out["summary"]
    assert s["total_cost"] == pytest.approx(75400.0)
    assert s["total_value"] == pytest.approx(88181.4)
    assert s["total_pnl"] == pytest.approx(12781.4)
    assert s["winners"] == 1 and s["losers"] == 1
    assert s["best"]["symbol"] == "NVDA"
    assert s["worst"]["symbol"] == "AAPL"
    # Weights are of market value and should sum to ~100.
    assert sum(r["weight_pct"] for r in out["positions"]) == pytest.approx(100, abs=0.1)
    assert s["concentration_pct"] > 90


def test_empty_portfolio_summary_is_safe():
    s = positions.portfolio_summary([])
    assert s["total_value"] == 0
    assert s["total_pnl_pct"] is None
    assert s["best"] is None


# --- lot aggregation -------------------------------------------------------
def test_aggregate_lots_weights_average_cost():
    parsed = positions.parse_positions([
        {"symbol": "NVDA", "shares": 400, "cost_basis": 178.50},
        {"symbol": "NVDA", "shares": 50, "cost_basis": 205.00},
    ])
    out = positions.value_portfolio(parsed, [FakeQuote("NVDA", 212.17)])
    agg = positions.aggregate_lots(out["positions"])
    assert len(agg) == 1
    assert agg[0]["shares"] == 450
    assert agg[0]["lots"] == 2
    # (400×178.50 + 50×205) / 450
    assert agg[0]["avg_cost"] == pytest.approx(181.4444, abs=1e-4)
    assert agg[0]["cost"] == pytest.approx(81650.0)


# --- spreadsheet round-trip ------------------------------------------------
def test_csv_round_trip_preserves_cost_basis():
    """Regression: the export has BOTH cost_basis and price columns, and an
    earlier version read `price` back as the cost basis."""
    parsed = positions.parse_positions(
        [{"symbol": "NVDA", "shares": 400, "cost_basis": 178.50,
          "opened": "2026-09-01"}])
    out = positions.value_portfolio(parsed, [FakeQuote("NVDA", 212.17, 1.21)])
    csv_text = exports.rows_to_csv(positions.to_csv_rows(out["positions"]))

    back = exports.parse_positions_file("holdings.csv", csv_text.encode())
    assert back[0]["cost_basis"] == pytest.approx(178.50)
    assert back[0]["shares"] == 400
    assert back[0]["opened"] == "2026-09-01"


def test_xlsx_round_trip_preserves_cost_basis():
    parsed = positions.parse_positions(
        [{"symbol": "MSFT", "shares": 25, "cost_basis": 412.30}])
    out = positions.value_portfolio(parsed, [FakeQuote("MSFT", 500.0)])
    blob = exports.sheets_to_xlsx({"Holdings": positions.to_csv_rows(out["positions"])})

    back = exports.parse_positions_file("holdings.xlsx", blob)
    assert back[0]["symbol"] == "MSFT"
    assert back[0]["cost_basis"] == pytest.approx(412.30)


def test_import_accepts_broker_header_spellings():
    csv_text = (b"Ticker,Qty,Average Cost,Trade Date,Notes\n"
                b'msft,25,"$412.30",2026-08-14,core holding\n')
    back = exports.parse_positions_file("broker.csv", csv_text)
    assert back == [{"symbol": "MSFT", "shares": 25.0, "cost_basis": 412.30,
                     "opened": "2026-08-14", "note": "core holding"}]


def test_import_falls_back_to_price_column_when_no_cost_basis():
    back = exports.parse_positions_file(
        "b.csv", b"Symbol,Shares,Price\nGOOG,12,205.50\n")
    assert back[0]["cost_basis"] == pytest.approx(205.50)


def test_import_skips_title_row_above_header():
    back = exports.parse_positions_file(
        "c.csv", b"My Portfolio 2026\n\nSymbol,Shares,Avg Cost\nGOOG,12,205.5\n")
    assert back[0]["symbol"] == "GOOG"


def test_import_parses_money_formatting():
    back = exports.parse_positions_file(
        "d.csv", b'Symbol,Shares,Cost Basis\nIBM,"1,000","$1,234.50"\n')
    assert back[0]["shares"] == 1000
    assert back[0]["cost_basis"] == pytest.approx(1234.50)


def test_import_without_symbol_column_raises():
    with pytest.raises(ValueError, match="symbol"):
        exports.parse_positions_file("x.csv", b"a,b\n1,2\n")


def test_import_drops_incomplete_rows():
    back = exports.parse_positions_file(
        "e.csv", b"Symbol,Shares,Cost Basis\nAAPL,10,100\nBAD,,\n,5,5\n")
    assert [r["symbol"] for r in back] == ["AAPL"]
