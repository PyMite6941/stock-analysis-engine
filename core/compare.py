"""Performance comparison for a set of holdings over a chosen window.

Answers the question an exported holdings file is actually for: "over the last
N months, which of these went up, which went down, and how did the book do
overall?"

Deliberately separates two different meanings of "gain", because conflating them
is the most common way people misread their own portfolio:

  * PERIOD return   — what the stock did over the window, regardless of when you
                      bought. This is the stock's performance.
  * SINCE-PURCHASE  — what YOU made, measured from your cost basis. This is your
                      performance, and it differs whenever you didn't buy at the
                      start of the window.

A position opened partway through the window gets `held_full_period: False`, so
the UI can stop pretending the period return was yours to collect.

Pure functions, no I/O, no AI — same contract as metrics.py.
"""

from __future__ import annotations

from .positions import Position, aggregate_lots, value_portfolio


def _series_bounds(hist: dict, since: str | None = None) -> tuple:
    """(start_date, start_close, end_date, end_close) for a close series.

    `since` clips the window to a position's open date when that date falls
    inside the period.
    """
    dates = (hist or {}).get("dates") or []
    closes = (hist or {}).get("closes") or (hist or {}).get("close") or []
    if not dates or not closes:
        return None, None, None, None

    start_i = 0
    if since:
        # First bar on or after the open date; fall back to the window start.
        start_i = next((i for i, d in enumerate(dates) if d[:10] >= since[:10]), 0)
        if start_i >= len(closes):
            start_i = 0
    return dates[start_i], closes[start_i], dates[-1], closes[-1]


def compare_positions(positions: list[Position], histories: dict,
                      quotes: list, period: str = "6mo",
                      benchmark: dict | None = None) -> dict:
    """Per-symbol and portfolio-level performance over `period`.

    `histories` maps SYMBOL -> {"dates": [...], "closes": [...]}.
    `benchmark` is an optional {"symbol", "dates", "closes"} for a like-for-like
    market comparison over the same window.
    """
    valued = value_portfolio(positions, quotes)
    lots = aggregate_lots(valued["positions"])

    # Earliest open date per symbol — a symbol is only "held all period" if its
    # oldest lot predates the window.
    opened_by_symbol: dict[str, str | None] = {}
    for p in positions:
        cur = opened_by_symbol.get(p.symbol)
        if p.opened and (cur is None or p.opened < cur):
            opened_by_symbol[p.symbol] = p.opened
        opened_by_symbol.setdefault(p.symbol, None)

    rows = []
    start_value = end_value = 0.0
    for lot in lots:
        sym = lot["symbol"]
        hist = histories.get(sym) or {}
        opened = opened_by_symbol.get(sym)
        w_start, _, _, _ = _series_bounds(hist)
        held_full = not opened or (w_start is not None and opened[:10] <= w_start[:10])

        # Value the period from the open date when the lot was bought mid-window.
        s_date, s_close, e_date, e_close = _series_bounds(
            hist, None if held_full else opened)

        row = {
            "symbol": sym,
            "shares": lot["shares"],
            "avg_cost": lot["avg_cost"],
            "cost": lot["cost"],
            "price": lot["price"],
            "market_value": lot["market_value"],
            # Since-purchase: what the holder actually made.
            "pnl": lot["pnl"],
            "pnl_pct": lot["pnl_pct"],
            "opened": opened,
            "held_full_period": held_full,
            "period_start_date": s_date,
            "period_start_price": round(s_close, 4) if s_close else None,
            "period_end_date": e_date,
            "period_end_price": round(e_close, 4) if e_close else None,
        }

        if s_close and e_close:
            pct = (e_close / s_close - 1) * 100
            # Period P/L on the shares currently held.
            dollars = lot["shares"] * (e_close - s_close)
            row["period_change_pct"] = round(pct, 2)
            row["period_change"] = round(dollars, 2)
            row["direction"] = "up" if pct > 0 else "down" if pct < 0 else "flat"
            start_value += lot["shares"] * s_close
            end_value += lot["shares"] * e_close
        else:
            row["period_change_pct"] = None
            row["period_change"] = None
            row["direction"] = None

        rows.append(row)

    rows.sort(key=lambda r: (r["period_change_pct"] is None,
                            -(r["period_change_pct"] or 0)))

    gainers = [r for r in rows if (r.get("period_change_pct") or 0) > 0]
    losers = [r for r in rows if (r.get("period_change_pct") or 0) < 0]
    port_pct = ((end_value / start_value - 1) * 100) if start_value else None

    summary = {
        "period": period,
        "n_symbols": len(rows),
        "gainers": len(gainers),
        "losers": len(losers),
        "unchanged": len(rows) - len(gainers) - len(losers),
        "start_value": round(start_value, 2),
        "end_value": round(end_value, 2),
        "period_change": round(end_value - start_value, 2),
        "period_change_pct": round(port_pct, 2) if port_pct is not None else None,
        "best": rows[0] and {"symbol": rows[0]["symbol"],
                             "period_change_pct": rows[0]["period_change_pct"]}
                if rows else None,
        "worst": ({"symbol": rows[-1]["symbol"],
                   "period_change_pct": rows[-1]["period_change_pct"]}
                  if rows and rows[-1].get("period_change_pct") is not None else None),
        # Since-purchase totals, for contrast with the period figures above.
        "total_cost": valued["summary"]["total_cost"],
        "total_value": valued["summary"]["total_value"],
        "total_pnl": valued["summary"]["total_pnl"],
        "total_pnl_pct": valued["summary"]["total_pnl_pct"],
        "partial_period_holdings": sum(1 for r in rows if not r["held_full_period"]),
    }

    out = {"period": period, "positions": rows, "summary": summary}

    if benchmark:
        _, b_start, _, b_end = _series_bounds(benchmark)
        if b_start and b_end:
            b_pct = (b_end / b_start - 1) * 100
            out["benchmark"] = {
                "symbol": benchmark.get("symbol", "SPY"),
                "period_change_pct": round(b_pct, 2),
                "start_price": round(b_start, 2),
                "end_price": round(b_end, 2),
                # Positive = the book beat the market over this window.
                "excess_pct": (round(port_pct - b_pct, 2)
                               if port_pct is not None else None),
                "verdict": (None if port_pct is None
                            else "ahead" if port_pct > b_pct else
                            "behind" if port_pct < b_pct else "level"),
            }

    return out


# Columns for the comparison CSV/XLSX export.
COMPARE_COLUMNS = ["symbol", "shares", "avg_cost", "period_start_date",
                   "period_start_price", "period_end_date", "period_end_price",
                   "period_change_pct", "period_change", "held_full_period",
                   "cost", "market_value", "pnl", "pnl_pct", "opened"]


def to_csv_rows(rows: list[dict]) -> list[list]:
    out = [COMPARE_COLUMNS]
    for r in rows:
        out.append([r.get(c) if r.get(c) is not None else "" for c in COMPARE_COLUMNS])
    return out
