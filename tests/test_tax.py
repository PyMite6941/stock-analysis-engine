"""Form 8949, Schedule D, and the wash-sale rule."""
import pytest

from core import tax
from core.positions import Position


def sale(symbol="NVDA", shares=100, cost_basis=200.0, exit_price=150.0,
         opened="2026-01-05", closed="2026-06-01", sid=None):
    """One realised row shaped like realized.parse_sales output."""
    proceeds = shares * exit_price
    cost = shares * cost_basis
    days = None
    if opened and closed:
        from core.realized import holding_days
        days = holding_days(opened, closed)
    return {
        "id": sid or "", "symbol": symbol, "shares": shares,
        "cost_basis": cost_basis, "exit_price": exit_price,
        "opened": opened, "closed": closed,
        "proceeds": round(proceeds, 2), "cost": round(cost, 2),
        "pnl": round(proceeds - cost, 2),
        "holding_days": days, "term": tax.term_for(days),
    }


# ---------------------------------------------------------------------------
# Wash sales
# ---------------------------------------------------------------------------
def test_loss_with_repurchase_inside_window_is_disallowed():
    loss = sale(closed="2026-06-01")                      # -5000
    rebuy = Position("NVDA", 100, 150.0, opened="2026-06-10")
    out = tax.wash_sales([loss], [rebuy])
    assert out["n_wash"] == 1
    assert out["total_disallowed"] == 5000.0
    assert out["rows"][0]["wash_shares"] == 100


def test_repurchase_before_the_sale_also_triggers_it():
    """The window is centred on the sale — buying first counts just as much.

    This is the half of the rule people miss: doubling up and then selling the
    old lot at a loss is still a wash sale.
    """
    loss = sale(closed="2026-06-01")
    early = Position("NVDA", 100, 150.0, opened="2026-05-20")
    out = tax.wash_sales([loss], [early])
    assert out["total_disallowed"] == 5000.0


def test_repurchase_outside_31_days_is_clean():
    loss = sale(closed="2026-06-01")
    late = Position("NVDA", 100, 150.0, opened="2026-07-05")   # 34 days after
    out = tax.wash_sales([loss], [late])
    assert out["n_wash"] == 0
    assert out["total_disallowed"] == 0.0


def test_boundary_day_30_is_inside_and_31_is_outside():
    loss = sale(closed="2026-06-01")
    on_30 = tax.wash_sales([loss], [Position("NVDA", 100, 150.0, "2026-07-01")])
    on_31 = tax.wash_sales([loss], [Position("NVDA", 100, 150.0, "2026-07-02")])
    assert on_30["n_wash"] == 1
    assert on_31["n_wash"] == 0


def test_partial_replacement_disallows_proportionally():
    """Replace 40 of 100 shares and only 40% of the loss is disallowed."""
    loss = sale(shares=100, closed="2026-06-01")               # -5000
    out = tax.wash_sales([loss], [Position("NVDA", 40, 150.0, "2026-06-10")])
    assert out["rows"][0]["wash_shares"] == 40
    assert out["total_disallowed"] == 2000.0


def test_gains_are_never_washed():
    win = sale(cost_basis=100.0, exit_price=150.0, closed="2026-06-01")
    out = tax.wash_sales([win], [Position("NVDA", 100, 150.0, "2026-06-10")])
    assert out["n_wash"] == 0


def test_a_sale_cannot_replace_itself():
    """The lot being sold is evidence of a purchase, but not a replacement.

    Without this guard every loss would wash itself, since the sale row is the
    source of its own implied buy.
    """
    loss = sale(opened="2026-05-25", closed="2026-06-01", sid="s1")
    out = tax.wash_sales([loss], [])
    assert out["n_wash"] == 0


def test_replacement_shares_are_consumed_only_once():
    """One 100-share rebuy cannot excuse two separate 100-share losses."""
    a = sale(shares=100, closed="2026-06-01", sid="a", opened="2026-01-01")
    b = sale(shares=100, closed="2026-06-02", sid="b", opened="2026-01-02")
    out = tax.wash_sales([a, b], [Position("NVDA", 100, 150.0, "2026-06-05")])
    assert out["n_wash"] == 1
    assert out["total_disallowed"] == 5000.0


def test_a_closed_lot_can_be_the_replacement():
    """Buy back, then sell again later — the rebuy still washes the first loss.

    The replacement is gone by the time we look, so it only exists as the
    `opened` date on the second sale.
    """
    first = sale(shares=100, opened="2026-01-01", closed="2026-06-01", sid="a")
    second = sale(shares=100, opened="2026-06-10", closed="2026-09-01",
                  exit_price=170.0, sid="b")
    out = tax.wash_sales([first, second], [])
    assert out["rows"][0]["wash_disallowed"] == 5000.0
    assert out["rows"][0]["replacements"][0]["source"] == "closed_lot"


def test_different_symbols_do_not_wash():
    loss = sale(symbol="NVDA", closed="2026-06-01")
    out = tax.wash_sales([loss], [Position("AMD", 100, 150.0, "2026-06-10")])
    assert out["n_wash"] == 0


def test_crypto_is_exempt_from_the_wash_rule():
    """1091 covers securities; crypto is property, so the loss stands."""
    loss = sale(symbol="BTC-USD", shares=1, cost_basis=90000.0,
                exit_price=60000.0, closed="2026-06-01")
    out = tax.wash_sales([loss], [Position("BTC-USD", 1, 60000.0, "2026-06-03")])
    assert out["n_wash"] == 0
    assert out["total_disallowed"] == 0.0
    assert out["crypto_exempt"] == ["BTC-USD"]
    assert out["rows"][0]["wash_exempt"] == "crypto"


def test_undated_sale_is_skipped_not_crashed():
    out = tax.wash_sales([sale(closed=None)], [])
    assert out["n_wash"] == 0


# ---------------------------------------------------------------------------
# Form 8949
# ---------------------------------------------------------------------------
def test_form_row_arithmetic_matches_the_form():
    """(h) = (d) proceeds - (e) basis + (g) adjustment."""
    loss = sale(closed="2026-06-01")                      # 15000 - 20000
    out = tax.form_8949_rows([loss], [Position("NVDA", 100, 150.0, "2026-06-10")])
    r = out["rows"][0]
    assert r["proceeds"] == 15000.0
    assert r["cost_basis"] == 20000.0
    assert r["adjustment"] == 5000.0
    assert r["code"] == "W"
    # The whole loss is disallowed, so the reported gain/loss is zero.
    assert r["gain_loss"] == 0.0


def test_box_depends_on_term_and_reporting_status():
    short = sale(opened="2026-01-05", closed="2026-06-01")
    long_ = sale(opened="2024-01-05", closed="2026-06-01")
    rep = tax.form_8949_rows([short, long_], [], basis_reported=True)["rows"]
    assert {r["box"] for r in rep} == {"A", "D"}
    unrep = tax.form_8949_rows([short, long_], [], basis_reported=False)["rows"]
    assert {r["box"] for r in unrep} == {"B", "E"}
    none = tax.form_8949_rows([short, long_], [], basis_reported=None)["rows"]
    assert {r["box"] for r in none} == {"C", "F"}


def test_dates_are_formatted_for_the_form():
    r = tax.form_8949_rows([sale(opened="2026-01-05", closed="2026-06-01")],
                           [])["rows"][0]
    assert r["date_acquired"] == "01/05/2026"
    assert r["date_sold"] == "06/01/2026"
    assert r["description"] == "100 sh. NVDA"


def test_year_filter_keeps_only_that_tax_year():
    a = sale(closed="2025-06-01", sid="a")
    b = sale(closed="2026-06-01", sid="b")
    out = tax.form_8949_rows([a, b], [], year=2026)
    assert len(out["rows"]) == 1
    assert out["rows"][0]["date_sold"].endswith("2026")


# ---------------------------------------------------------------------------
# Schedule D
# ---------------------------------------------------------------------------
def test_schedule_d_splits_short_and_long():
    short = sale(opened="2026-01-05", closed="2026-06-01")          # -5000
    long_ = sale(opened="2024-01-05", closed="2026-06-01",
                 cost_basis=100.0, exit_price=180.0)                # +8000
    rows = tax.form_8949_rows([short, long_], [])["rows"]
    d = tax.schedule_d(rows)
    assert d["short_term"]["net"] == -5000.0
    assert d["long_term"]["net"] == 8000.0
    assert d["net_gain_loss"] == 3000.0


def test_net_loss_is_capped_at_3000_with_a_carryforward():
    """The $3,000 annual cap is the number people are most surprised by."""
    big = sale(shares=1000, cost_basis=200.0, exit_price=180.0,
               opened="2026-01-05", closed="2026-06-01")            # -20000
    d = tax.schedule_d(tax.form_8949_rows([big], [])["rows"])
    assert d["net_gain_loss"] == -20000.0
    assert d["deductible_loss"] == -3000.0
    assert d["loss_carryforward"] == 17000.0


def test_small_net_loss_has_no_carryforward():
    small = sale(shares=10, cost_basis=200.0, exit_price=150.0,
                 opened="2026-01-05", closed="2026-06-01")          # -500
    d = tax.schedule_d(tax.form_8949_rows([small], [])["rows"])
    assert d["deductible_loss"] == -500.0
    assert d["loss_carryforward"] is None


def test_net_gain_has_no_deduction_fields():
    win = sale(cost_basis=100.0, exit_price=150.0, closed="2026-06-01")
    d = tax.schedule_d(tax.form_8949_rows([win], [])["rows"])
    assert d["deductible_loss"] is None
    assert d["loss_carryforward"] is None


def test_schedule_d_subtotals_one_line_per_box():
    rows = tax.form_8949_rows(
        [sale(opened="2026-01-05", closed="2026-06-01", sid="a"),
         sale(opened="2026-02-05", closed="2026-06-02", sid="b"),
         sale(opened="2023-01-05", closed="2026-06-03", sid="c")], [])["rows"]
    d = tax.schedule_d(rows)
    by_box = {l["box"]: l for l in d["lines"]}
    assert by_box["A"]["n_rows"] == 2
    assert by_box["D"]["n_rows"] == 1


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------
def test_csv_has_the_forms_own_headers():
    rows = tax.form_8949_rows([sale(closed="2026-06-01")], [])["rows"]
    grid = tax.to_csv_rows(rows)
    assert grid[0][0] == "Box"
    assert "Gain or (loss)" in grid[0]
    assert len(grid) == 2


def test_wash_sheet_lists_the_replacement_buys():
    rows = tax.form_8949_rows(
        [sale(closed="2026-06-01")],
        [Position("NVDA", 100, 150.0, "2026-06-10")])["rows"]
    grid = tax.wash_csv_rows(rows)
    assert len(grid) == 2
    assert "2026-06-10" in grid[1][4]


def test_wash_sheet_is_empty_without_wash_sales():
    rows = tax.form_8949_rows([sale(closed="2026-06-01")], [])["rows"]
    assert len(tax.wash_csv_rows(rows)) == 1      # header only


def test_empty_input_is_empty_output_not_an_error():
    out = tax.form_8949_rows([], [])
    assert out["rows"] == []
    d = tax.schedule_d([])
    assert d["net_gain_loss"] == 0.0
    assert d["lines"] == []
