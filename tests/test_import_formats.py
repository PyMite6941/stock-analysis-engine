"""Real broker export shapes, and the per-share vs total cost-basis trap.

The trap is the important one. "Cost Basis" means the lot TOTAL at Schwab and
PER SHARE at Fidelity. Importing a total as per-share produced a position
25x too expensive, looked entirely plausible on screen, and nothing raised.
"""

import datetime
import io

import pytest
from openpyxl import Workbook

from backend import exports


def parse(content, name="holdings.csv"):
    return exports.parse_positions_file(name, content)


def one(content, name="holdings.csv"):
    rows = parse(content, name)
    assert rows, "expected at least one row"
    return rows[0]


# --- per-share vs total ----------------------------------------------------
def test_schwab_total_cost_basis_is_divided_by_shares():
    """Price + Cost Basis, where Cost Basis is the whole lot."""
    r = one(b"Symbol,Quantity,Price,Cost Basis\nMSFT,25,500.00,10307.50\n")
    assert r["cost_basis"] == pytest.approx(412.30, abs=0.01)


def test_fidelity_per_share_basis_is_left_alone():
    r = one(b"Symbol,Quantity,Average Cost Basis\nAAPL,10,400.00\n")
    assert r["cost_basis"] == pytest.approx(400.0)


def test_our_own_export_round_trips_unchanged():
    """cost_basis and price both present; price must not win, and must not
    trigger the total-detection either."""
    r = one(b"symbol,shares,cost_basis,price\nNVDA,400,178.5,212.17\n")
    assert r["cost_basis"] == pytest.approx(178.5)


def test_price_is_used_when_it_is_the_only_cost_column():
    r = one(b"ticker,qty,price\nKO,200,62\n")
    assert r["cost_basis"] == pytest.approx(62.0)


def test_explicit_total_cost_column_is_divided():
    r = one(b"Symbol,Shares,Total Cost\nKO,200,12400.00\n")
    assert r["cost_basis"] == pytest.approx(62.0)


def test_last_price_column_does_not_become_the_cost_basis():
    """Today's price is not what was paid."""
    r = one(b"Symbol,Shares,Cost Basis,Last Price\nAAPL,10,400.00,331.34\n")
    assert r["cost_basis"] == pytest.approx(400.0)


# --- broker header spellings ----------------------------------------------
@pytest.mark.parametrize("content,expect", [
    (b"Symbol,Quantity,Average Cost Basis\nAAPL,10,400\n", 400.0),
    (b"Symbol,Shares,Share Price\nVTI,15,300\n", 300.0),
    (b"Symbol,Shares,Cost Per Share\nX,5,10\n", 10.0),
    (b"Symbol,Shares,Price Per Share\nX,5,10\n", 10.0),
    (b"Symbol,Shares,Unit Cost\nX,5,10\n", 10.0),
    (b"Symbol,Shares,Avg Price\nX,5,10\n", 10.0),
    (b"Ticker,Qty,Average Cost\nX,5,10\n", 10.0),
])
def test_broker_header_spellings(content, expect):
    assert one(content)["cost_basis"] == pytest.approx(expect)


# --- delimiters ------------------------------------------------------------
@pytest.mark.parametrize("content", [
    b"Symbol,Shares,Cost Basis\nAAPL,10,100\n",
    b"Symbol;Shares;Cost Basis\nAAPL;10;100\n",
    b"Symbol\tShares\tCost Basis\nAAPL\t10\t100\n",
    b"Symbol|Shares|Cost Basis\nAAPL|10|100\n",
])
def test_delimiters_are_sniffed(content):
    r = one(content)
    assert r["symbol"] == "AAPL" and r["shares"] == 10


def test_sniff_prefers_the_densest_separator():
    assert exports.sniff_delimiter("a;b;c\n1;2;3") == ";"
    assert exports.sniff_delimiter("a,b,c\n1,2,3") == ","
    assert exports.sniff_delimiter("single-column") == ","


# --- shapes that must keep working ----------------------------------------
def test_bom_and_crlf():
    r = one("\ufeffSymbol,Shares,Cost Basis\r\nIBM,10,200\r\n".encode("utf-8"))
    assert r["symbol"] == "IBM"


def test_currency_and_thousands_separators():
    r = one(b'Symbol,Shares,Cost Basis\nIBM,"1,000","$1,234.50"\n')
    assert r["shares"] == 1000 and r["cost_basis"] == pytest.approx(1234.5)


def test_short_position_keeps_its_sign():
    assert one(b"Symbol,Shares,Cost Basis\nTSLA,-5,180\n")["shares"] == -5


def test_accounting_negative_parentheses():
    assert one(b"Symbol,Shares,Cost Basis\nTSLA,(5),180\n")["shares"] == -5


def test_clock_time_on_the_open_date_survives():
    r = one(b"symbol,shares,cost_basis,opened\nTSLA,50,180,2026-09-16 09:45\n")
    assert r["opened"] == "2026-09-16 09:45"


def test_unknown_columns_are_ignored():
    r = one(b"Symbol,Shares,Cost Basis,Sector,Rating\nAAPL,10,100,Tech,Buy\n")
    assert r["symbol"] == "AAPL"


# --- xlsx ------------------------------------------------------------------
def _xlsx(rows):
    wb = Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_xlsx_datetime_cells_keep_the_clock_time():
    r = one(_xlsx([["Symbol", "Shares", "Cost Basis", "Trade Date"],
                   ["TSLA", 50, 180.0, datetime.datetime(2026, 9, 16, 9, 45)]]),
            "h.xlsx")
    assert r["opened"] == "2026-09-16 09:45"


def test_xlsx_date_cells_have_no_spurious_time():
    r = one(_xlsx([["Symbol", "Shares", "Cost Basis", "Trade Date"],
                   ["KO", 200, 62.0, datetime.date(2024, 3, 1)]]), "h.xlsx")
    assert r["opened"] == "2024-03-01"


def test_xlsx_total_cost_basis_is_also_resolved():
    r = one(_xlsx([["Symbol", "Quantity", "Price", "Cost Basis"],
                   ["MSFT", 25, 500.0, 10307.50]]), "h.xlsx")
    assert r["cost_basis"] == pytest.approx(412.30, abs=0.01)


# --- failures must be clean ------------------------------------------------
@pytest.mark.parametrize("content", [b"", b"a,b,c\n1,2,3\n", b"<html></html>"])
def test_unusable_files_raise_valueerror_not_500(content):
    with pytest.raises(ValueError):
        parse(content)


def test_header_only_file_yields_no_rows():
    assert parse(b"Symbol,Shares,Cost Basis\n") == []


def test_rows_missing_required_numbers_are_dropped():
    rows = parse(b"Symbol,Shares,Cost Basis\nAAPL,10,100\nBAD,,\n,5,5\n")
    assert [r["symbol"] for r in rows] == ["AAPL"]


def test_csv_content_mislabelled_as_xlsx_still_imports():
    """Routing on the extension alone died with "File is not a zip file" for a
    perfectly importable file — a real .xlsx always starts with PK."""
    r = one(b"Symbol,Shares,Cost Basis\nAAPL,10,100\n", "holdings.xlsx")
    assert r["symbol"] == "AAPL"


def test_real_xlsx_is_still_detected_by_content():
    blob = _xlsx([["Symbol", "Shares", "Cost Basis"], ["AAPL", 10, 100]])
    assert blob[:2] == b"PK"
    assert one(blob, "mislabelled.csv")["symbol"] == "AAPL"
