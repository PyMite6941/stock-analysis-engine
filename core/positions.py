"""Holdings valuation: what you bought vs what it is worth now. No I/O, no AI.

The browser owns the position list (localStorage) — this module owns the maths.
Keeping it here rather than in JS means the number the UI shows, the number in
the CSV export, and the number the AI analyst reasons over are all the same
number, which is the whole point of core/.

A "position" is the minimal honest record of a buy:

    {"symbol": "NVDA", "shares": 400, "cost_basis": 178.50,
     "opened": "2026-09-01", "note": "post-earnings add"}

`cost_basis` is per share. Multiple buys of the same symbol stay as separate
lots; `aggregate_lots` rolls them into one weighted-average line when asked.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict, field
from typing import Optional


@dataclass
class Position:
    symbol: str
    shares: float
    cost_basis: float                  # price paid per share
    opened: Optional[str] = None       # ISO date
    note: Optional[str] = None
    id: Optional[str] = None           # client-generated, round-trips untouched

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def cost(self) -> float:
        return self.shares * self.cost_basis


def parse_positions(raw: list[dict]) -> list[Position]:
    """Build Positions from loosely-typed client JSON, skipping unusable rows.

    A bad row is dropped rather than raising: one malformed localStorage entry
    should not blank out an entire portfolio view.
    """
    out = []
    for r in raw or []:
        try:
            symbol = str(r["symbol"]).strip().upper()
            shares = float(r["shares"])
            cost_basis = float(r["cost_basis"])
        except (KeyError, TypeError, ValueError):
            continue
        if not symbol or shares == 0 or cost_basis < 0:
            continue
        out.append(Position(
            symbol=symbol, shares=shares, cost_basis=cost_basis,
            opened=(str(r["opened"]) if r.get("opened") else None),
            note=(str(r["note"]) if r.get("note") else None),
            id=(str(r["id"]) if r.get("id") else None),
        ))
    return out


def value_position(p: Position, price: Optional[float],
                   day_change: Optional[float] = None) -> dict:
    """One lot, marked to market.

    `day_change` is the quote's absolute move vs the previous close, so day P/L
    is a separate line from the since-purchase P/L — a position can be green
    overall and red today, and conflating the two is how people misread a
    portfolio screen.
    """
    cost = p.cost
    row = {
        **p.to_dict(),
        "cost": round(cost, 2),
        "price": round(price, 4) if price else None,
        "market_value": None,
        "pnl": None,
        "pnl_pct": None,
        "day_pnl": None,
        "is_open": bool(price),
    }
    if not price:
        return row

    value = p.shares * price
    pnl = value - cost
    row["market_value"] = round(value, 2)
    row["pnl"] = round(pnl, 2)
    row["pnl_pct"] = round(pnl / cost * 100, 2) if cost else None
    row["direction"] = "up" if pnl > 0 else "down" if pnl < 0 else "flat"
    if day_change is not None:
        row["day_pnl"] = round(p.shares * day_change, 2)
    return row


def value_portfolio(positions: list[Position], quotes: list) -> dict:
    """Mark every lot to market and roll them up.

    `quotes` is a list of core.data.Quote (or anything with .symbol/.price/
    .change). Symbols with no quote are still listed, just unvalued.
    """
    by_symbol = {}
    for q in quotes or []:
        sym = getattr(q, "symbol", None) or (q.get("symbol") if isinstance(q, dict) else None)
        if sym:
            by_symbol[sym.upper()] = q

    rows = []
    for p in positions:
        q = by_symbol.get(p.symbol)
        price = getattr(q, "price", None) if q is not None else None
        change = getattr(q, "change", None) if q is not None else None
        if isinstance(q, dict):
            price, change = q.get("price"), q.get("change")
        rows.append(value_position(p, price, change))

    return {"positions": rows, "summary": portfolio_summary(rows)}


def portfolio_summary(rows: list[dict]) -> dict:
    """Totals plus the best/worst lines. Weights are of MARKET value, not cost."""
    priced = [r for r in rows if r.get("market_value") is not None]
    total_cost = sum(r["cost"] for r in priced)
    total_value = sum(r["market_value"] for r in priced)
    total_pnl = total_value - total_cost
    day_pnls = [r["day_pnl"] for r in priced if r.get("day_pnl") is not None]

    for r in priced:
        r["weight_pct"] = (round(r["market_value"] / total_value * 100, 2)
                           if total_value else None)

    winners = [r for r in priced if r["pnl"] > 0]
    return {
        "n_positions": len(rows),
        "n_priced": len(priced),
        "n_unpriced": len(rows) - len(priced),
        "total_cost": round(total_cost, 2),
        "total_value": round(total_value, 2),
        "total_pnl": round(total_pnl, 2),
        "total_pnl_pct": round(total_pnl / total_cost * 100, 2) if total_cost else None,
        "day_pnl": round(sum(day_pnls), 2) if day_pnls else None,
        "day_pnl_pct": (round(sum(day_pnls) / (total_value - sum(day_pnls)) * 100, 2)
                        if day_pnls and total_value - sum(day_pnls) else None),
        "winners": len(winners),
        "losers": len(priced) - len(winners),
        "best": _argextreme(priced, "pnl_pct", max),
        "worst": _argextreme(priced, "pnl_pct", min),
        "largest_holding": _argextreme(priced, "market_value", max),
        # A single line worth more than a third of the book is the concentration
        # risk people most often miss on their own spreadsheet.
        "concentration_pct": (round(max((r["weight_pct"] or 0) for r in priced), 2)
                              if priced else None),
    }


def aggregate_lots(rows: list[dict]) -> list[dict]:
    """Collapse multiple lots of the same symbol into weighted-average lines."""
    agg: dict[str, dict] = {}
    for r in rows:
        sym = r["symbol"]
        a = agg.setdefault(sym, {
            "symbol": sym, "shares": 0.0, "cost": 0.0, "market_value": 0.0,
            "lots": 0, "price": r.get("price"), "day_pnl": 0.0,
        })
        a["shares"] += r["shares"]
        a["cost"] += r["cost"]
        a["lots"] += 1
        if r.get("market_value") is not None:
            a["market_value"] += r["market_value"]
        if r.get("day_pnl") is not None:
            a["day_pnl"] += r["day_pnl"]
        a["price"] = r.get("price") or a["price"]

    out = []
    for a in agg.values():
        pnl = a["market_value"] - a["cost"] if a["market_value"] else None
        out.append({
            "symbol": a["symbol"],
            "shares": round(a["shares"], 6),
            "lots": a["lots"],
            "avg_cost": round(a["cost"] / a["shares"], 4) if a["shares"] else None,
            "cost": round(a["cost"], 2),
            "price": a["price"],
            "market_value": round(a["market_value"], 2) if a["market_value"] else None,
            "pnl": round(pnl, 2) if pnl is not None else None,
            "pnl_pct": round(pnl / a["cost"] * 100, 2) if pnl is not None and a["cost"] else None,
            "day_pnl": round(a["day_pnl"], 2) if a["day_pnl"] else None,
        })
    return sorted(out, key=lambda r: -(r["market_value"] or 0))


def _argextreme(rows: list[dict], key: str, fn):
    candidates = [r for r in rows if r.get(key) is not None]
    if not candidates:
        return None
    r = fn(candidates, key=lambda x: x[key])
    return {"symbol": r["symbol"], key: r[key]}


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
CSV_COLUMNS = ["symbol", "shares", "cost_basis", "opened", "cost", "price",
               "market_value", "pnl", "pnl_pct", "day_pnl", "weight_pct", "note"]


def to_csv_rows(rows: list[dict]) -> list[list]:
    """Rows for the holdings CSV export, header first."""
    out = [CSV_COLUMNS]
    for r in rows:
        out.append([r.get(c) if r.get(c) is not None else "" for c in CSV_COLUMNS])
    return out
