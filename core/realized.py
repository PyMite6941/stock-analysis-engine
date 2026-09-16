"""Selling: lot matching, realised gains, and holding periods. No I/O, no AI.

Recording a buy is easy. Recording a SALE is where the real accounting lives,
because a sale doesn't come from "the position" — it comes from specific lots,
and which lots you pick changes both your tax bill and your reported gain.

Three matching methods, all standard:

  FIFO      oldest lots first. The default nearly everywhere, and the assumption
            brokers apply if you don't say otherwise.
  LIFO      newest lots first. Often defers gains in a rising market.
  SPECIFIC  you name the lot. The only method that lets you deliberately harvest
            a loss or reach for long-term treatment.

Holding period matters more than most people realise: in the US, over one year
is long-term and taxed far more favourably. `LONG_TERM_DAYS` marks the boundary
and every realised row is labelled, so "should I wait a week" is answerable.

This module computes; it does not advise. It is not tax advice, and the numbers
here are a personal record, not a substitute for your broker's 1099.
"""

from __future__ import annotations

from datetime import date, datetime

from .positions import Position, parse_positions

LONG_TERM_DAYS = 366   # strictly MORE than one year, per the US holding rule

FIFO, LIFO, SPECIFIC = "fifo", "lifo", "specific"


# Accepted timestamp shapes. A plain date is normal for investing; the time is
# there for day traders, who can open and close the same lot within a session and
# whose "holding period" is measured in minutes, not days.
_DT_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M",
               "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d")


def _to_datetime(value) -> datetime | None:
    """Parse 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM[:SS]' (T separator accepted)."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    text = str(value).strip()
    for fmt in _DT_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _to_date(value) -> date | None:
    dt = _to_datetime(value)
    return dt.date() if dt else None


def has_time(value) -> bool:
    """True when the stamp carries a clock time, not just a date.

    Checked on the STRING, not the parsed value: midnight is a real trade time,
    so "2026-09-16 00:00" must count as timed even though every field is zero.
    """
    if isinstance(value, datetime):
        return True
    if not value or isinstance(value, date):
        return False
    return _to_datetime(value) is not None and len(str(value).strip()) > 10


def holding_days(opened, closed) -> int | None:
    """Calendar days held. Uses the date part, which is what tax rules use."""
    a, b = _to_date(opened), _to_date(closed)
    if not a or not b:
        return None
    return (b - a).days


def holding_minutes(opened, closed) -> float | None:
    """Exact duration in minutes when both stamps carry a time.

    Returns None unless BOTH have a clock time — otherwise the answer would be
    a fiction built from an assumed midnight.
    """
    a, b = _to_datetime(opened), _to_datetime(closed)
    if not a or not b or not has_time(opened) or not has_time(closed):
        return None
    return round((b - a).total_seconds() / 60.0, 2)


def format_duration(minutes: float | None, days: int | None) -> str | None:
    """Human-readable holding period, preferring the precise figure."""
    if minutes is not None:
        if minutes < 60:
            return f"{minutes:.0f}m"
        if minutes < 60 * 24:
            return f"{minutes / 60:.1f}h"
        return f"{minutes / 1440:.1f}d"
    if days is None:
        return None
    if days < 365:
        return f"{days}d"
    return f"{days / 365.25:.1f}y"


def term_for(days: int | None) -> str:
    """"long" once held more than a year, else "short"; "unknown" without dates."""
    if days is None:
        return "unknown"
    return "long" if days >= LONG_TERM_DAYS else "short"


def days_to_long_term(opened, as_of=None) -> int | None:
    """How many more days until this lot qualifies as long-term. 0 if already."""
    a = _to_date(opened)
    if not a:
        return None
    ref = _to_date(as_of) or date.today()
    return max(0, LONG_TERM_DAYS - (ref - a).days)


# ---------------------------------------------------------------------------
# Matching a sale against open lots
# ---------------------------------------------------------------------------
def match_sale(lots: list[Position], symbol: str, shares: float, price: float,
               sold_on: str | None = None, method: str = FIFO,
               lot_ids: list[str] | None = None) -> dict:
    """Consume `shares` of `symbol` from `lots` and return the realised rows.

    Returns {"realized": [...], "remaining_lots": [...], "unmatched": float}.
    `unmatched` is shares sold beyond what was held — a short, or more likely a
    typo. It's reported rather than raised so the UI can say which.

    The input list is not mutated; a new lot list comes back.
    """
    symbol = symbol.upper()
    if shares <= 0 or price < 0:
        return {"realized": [], "remaining_lots": list(lots), "unmatched": 0.0,
                "error": "Sale needs a positive share count and a price."}

    candidates = [l for l in lots if l.symbol == symbol and l.shares > 0]
    others = [l for l in lots if l.symbol != symbol or l.shares <= 0]

    if method == SPECIFIC and lot_ids:
        order = {lid: i for i, lid in enumerate(lot_ids)}
        chosen = [l for l in candidates if l.id in order]
        chosen.sort(key=lambda l: order.get(l.id, 1e9))
        rest = [l for l in candidates if l.id not in order]
        queue = chosen + rest
    elif method == LIFO:
        # Newest first; undated lots last, since we can't prove they're recent.
        queue = sorted(candidates,
                       key=lambda l: (l.opened is not None, l.opened or ""),
                       reverse=True)
    else:
        # FIFO: oldest first; undated lots last, so a missing date never
        # silently claims the long-term treatment that an old lot would get.
        queue = sorted(candidates, key=lambda l: (l.opened is None, l.opened or ""))

    remaining = float(shares)
    realized, leftovers = [], []

    for lot in queue:
        if remaining <= 1e-9:
            leftovers.append(lot)
            continue
        take = min(lot.shares, remaining)
        remaining -= take
        days = holding_days(lot.opened, sold_on)
        minutes = holding_minutes(lot.opened, sold_on)
        proceeds = take * price
        cost = take * lot.cost_basis
        realized.append({
            "symbol": symbol,
            "shares": round(take, 6),
            "cost_basis": lot.cost_basis,
            "exit_price": price,
            "opened": lot.opened,
            "closed": sold_on,
            "proceeds": round(proceeds, 2),
            "cost": round(cost, 2),
            "pnl": round(proceeds - cost, 2),
            "pnl_pct": round((proceeds - cost) / cost * 100, 2) if cost else None,
            "holding_days": days,
            "holding_minutes": minutes,
            "holding_label": format_duration(minutes, days),
            "intraday": bool(minutes is not None and days == 0),
            "term": term_for(days),
            "lot_id": lot.id,
            "method": method,
        })
        left = lot.shares - take
        if left > 1e-9:
            leftovers.append(Position(
                symbol=lot.symbol, shares=round(left, 6),
                cost_basis=lot.cost_basis, opened=lot.opened,
                note=lot.note, id=lot.id))

    return {
        "realized": realized,
        "remaining_lots": others + leftovers,
        "unmatched": round(remaining, 6),
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def parse_sales(raw: list[dict]) -> list[dict]:
    """Normalise stored sale records, dropping rows that can't be used."""
    out = []
    for r in raw or []:
        try:
            symbol = str(r["symbol"]).strip().upper()
            shares = float(r["shares"])
            cost_basis = float(r["cost_basis"])
            exit_price = float(r["exit_price"])
        except (KeyError, TypeError, ValueError):
            continue
        if not symbol or shares <= 0:
            continue
        proceeds, cost = shares * exit_price, shares * cost_basis
        days = holding_days(r.get("opened"), r.get("closed"))
        minutes = holding_minutes(r.get("opened"), r.get("closed"))
        out.append({
            "id": str(r.get("id") or ""),
            "symbol": symbol,
            "shares": shares,
            "cost_basis": cost_basis,
            "exit_price": exit_price,
            "opened": r.get("opened"),
            "closed": r.get("closed"),
            "proceeds": round(proceeds, 2),
            "cost": round(cost, 2),
            "pnl": round(proceeds - cost, 2),
            "pnl_pct": round((proceeds - cost) / cost * 100, 2) if cost else None,
            "holding_days": days,
            "holding_minutes": minutes,
            "holding_label": format_duration(minutes, days),
            "intraday": bool(minutes is not None and days == 0),
            "term": term_for(days),
            "note": r.get("note"),
        })
    return out


def realized_summary(sales: list[dict], year: int | None = None) -> dict:
    """Totals, split by holding period — the split that drives the tax bill."""
    rows = sales
    if year:
        rows = [s for s in sales if (s.get("closed") or "")[:4] == str(year)]

    if not rows:
        return {"n_sales": 0, "total_pnl": 0.0, "total_proceeds": 0.0,
                "total_cost": 0.0, "short_term_pnl": 0.0, "long_term_pnl": 0.0,
                "wins": 0, "losses": 0, "win_rate_pct": None, "year": year,
                "best": None, "worst": None, "avg_holding_days": None}

    short = [s for s in rows if s["term"] == "short"]
    long_ = [s for s in rows if s["term"] == "long"]
    wins = [s for s in rows if s["pnl"] > 0]
    held = [s["holding_days"] for s in rows if s["holding_days"] is not None]
    total_cost = sum(s["cost"] for s in rows)
    total_pnl = sum(s["pnl"] for s in rows)

    def extreme(fn):
        r = fn(rows, key=lambda s: s["pnl"])
        return {"symbol": r["symbol"], "pnl": r["pnl"], "pnl_pct": r["pnl_pct"]}

    return {
        "year": year,
        "n_sales": len(rows),
        "total_proceeds": round(sum(s["proceeds"] for s in rows), 2),
        "total_cost": round(total_cost, 2),
        "total_pnl": round(total_pnl, 2),
        "total_pnl_pct": round(total_pnl / total_cost * 100, 2) if total_cost else None,
        "short_term_pnl": round(sum(s["pnl"] for s in short), 2),
        "long_term_pnl": round(sum(s["pnl"] for s in long_), 2),
        "n_short_term": len(short),
        "n_long_term": len(long_),
        "wins": len(wins),
        "losses": len(rows) - len(wins),
        "win_rate_pct": round(len(wins) / len(rows) * 100, 1),
        "avg_holding_days": round(sum(held) / len(held)) if held else None,
        "n_intraday": sum(1 for s in rows if s.get("intraday")),
        "intraday_pnl": round(sum(s["pnl"] for s in rows if s.get("intraday")), 2),
        "best": extreme(max),
        "worst": extreme(min),
    }


def realized_by_year(sales: list[dict]) -> list[dict]:
    """Per-tax-year roll-up, newest year first."""
    years = sorted({(s.get("closed") or "")[:4] for s in sales if s.get("closed")},
                   reverse=True)
    out = []
    for y in years:
        if not y.isdigit():
            continue
        s = realized_summary(sales, int(y))
        s["year"] = int(y)
        out.append(s)
    return out


def lots_approaching_long_term(lots: list[Position], as_of=None,
                               within_days: int = 45) -> list[dict]:
    """Open lots that cross into long-term treatment soon.

    Purely informational: it tells you the date, not what to do about it.
    """
    out = []
    for lot in lots:
        left = days_to_long_term(lot.opened, as_of)
        if left is None or left <= 0 or left > within_days:
            continue
        out.append({"symbol": lot.symbol, "shares": lot.shares,
                    "opened": lot.opened, "days_to_long_term": left,
                    "id": lot.id})
    return sorted(out, key=lambda r: r["days_to_long_term"])


CSV_COLUMNS = ["symbol", "shares", "opened", "closed", "holding_days",
               "holding_label", "term",
               "cost_basis", "exit_price", "cost", "proceeds", "pnl", "pnl_pct",
               "note"]


def to_csv_rows(rows: list[dict]) -> list[list]:
    out = [CSV_COLUMNS]
    for r in rows:
        out.append([r.get(c) if r.get(c) is not None else "" for c in CSV_COLUMNS])
    return out
