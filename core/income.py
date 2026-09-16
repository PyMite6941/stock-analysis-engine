"""Dividend income from a set of holdings. Pure math, no I/O, no AI.

The number income investors actually care about is YIELD ON COST — the dividend
measured against what you paid, not against today's price. A stock bought at $40
now paying $3 yields 7.5% to you and 3% to someone buying today, and every free
tool shows the 3%. Both are here, side by side.

Projections are forward-looking estimates from the declared rate. Companies cut
dividends, so `annual_income` is what would be paid if nothing changes, which is
an assumption, not a promise. Payout ratio is included precisely because it's the
best cheap warning sign that a dividend is stretched.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from .positions import Position, aggregate_lots, value_portfolio

# Above this share of earnings, a dividend is being paid out of more than the
# business comfortably earns. Not a prediction of a cut — a reason to look.
STRETCHED_PAYOUT_PCT = 80.0

# Most US dividend payers are quarterly. The provider gives the MOST RECENT
# ex-date, not the next one, so a future date has to be projected — and labelled
# as a projection, because a company can move or cancel it.
QUARTER_DAYS = 91


def _parse_date(value) -> date | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def next_ex_date(last_ex, today: date | None = None) -> dict:
    """Project the next ex-dividend date from the last one.

    Yahoo's `ex_div_date` is usually the most recent ex-date, which is why a
    naive "upcoming dividends" list ends up full of dates that already passed.
    If the stored date is still in the future we use it as-is; otherwise we roll
    it forward in quarters and flag the result as estimated.
    """
    d = _parse_date(last_ex)
    today = today or date.today()
    if not d:
        return {"date": None, "estimated": False, "days_away": None,
                "last_ex_date": None}

    if d >= today:
        return {"date": d.isoformat(), "estimated": False,
                "days_away": (d - today).days, "last_ex_date": d.isoformat()}

    nxt = d
    # Cap the roll-forward: a date years stale means the payer probably stopped.
    for _ in range(8):
        nxt = nxt + timedelta(days=QUARTER_DAYS)
        if nxt >= today:
            return {"date": nxt.isoformat(), "estimated": True,
                    "days_away": (nxt - today).days,
                    "last_ex_date": d.isoformat()}
    return {"date": None, "estimated": False, "days_away": None,
            "last_ex_date": d.isoformat(), "stale": True}


def position_income(row: dict, info: dict) -> dict:
    """Annual income and both yields for one aggregated holding.

    `info` is the provider's income block: rate, dividend_yield_pct,
    payout_ratio_pct, five_year_avg_yield_pct, ex_div_date.
    """
    rate = info.get("rate")           # declared annual dividend per share
    shares = row.get("shares") or 0
    cost = row.get("cost") or 0
    value = row.get("market_value")

    out = {
        "symbol": row["symbol"],
        "shares": shares,
        "avg_cost": row.get("avg_cost"),
        "price": row.get("price"),
        "cost": round(cost, 2),
        "market_value": value,
        "rate": rate,
        "payout_ratio_pct": info.get("payout_ratio_pct"),
        "five_year_avg_yield_pct": info.get("five_year_avg_yield_pct"),
        "ex_div_date": info.get("ex_div_date"),
        "next_ex": next_ex_date(info.get("ex_div_date")),
        "pays_dividend": bool(rate),
    }

    if not rate or not shares:
        out.update({"annual_income": None, "yield_on_cost_pct": None,
                    "current_yield_pct": info.get("dividend_yield_pct"),
                    "monthly_income": None})
        return out

    annual = shares * rate
    out["annual_income"] = round(annual, 2)
    out["monthly_income"] = round(annual / 12, 2)
    out["quarterly_income"] = round(annual / 4, 2)
    # The number that's actually yours.
    out["yield_on_cost_pct"] = round(annual / cost * 100, 2) if cost else None
    out["current_yield_pct"] = (round(annual / value * 100, 2) if value
                               else info.get("dividend_yield_pct"))
    out["stretched"] = bool(out["payout_ratio_pct"]
                            and out["payout_ratio_pct"] > STRETCHED_PAYOUT_PCT)
    return out


def portfolio_income(positions: list[Position], quotes: list,
                     income_by_symbol: dict) -> dict:
    """Income roll-up across all holdings.

    `income_by_symbol` maps SYMBOL -> the provider's income dict.
    """
    valued = value_portfolio(positions, quotes)
    lots = aggregate_lots(valued["positions"])

    rows = [position_income(lot, income_by_symbol.get(lot["symbol"], {}) or {})
            for lot in lots]
    rows.sort(key=lambda r: -(r.get("annual_income") or 0))

    payers = [r for r in rows if r.get("annual_income")]
    total_income = sum(r["annual_income"] for r in payers)
    total_cost = sum(r["cost"] for r in rows)
    total_value = sum(r["market_value"] or 0 for r in rows)

    # Genuinely upcoming ex-dates, soonest first. The ex-date is the cutoff: buy
    # on or after it and you don't get that payment. Projected dates are flagged,
    # since the provider only reports the most recent one.
    upcoming = sorted(
        ({"symbol": r["symbol"],
          "ex_div_date": r["next_ex"]["date"],
          "estimated": r["next_ex"]["estimated"],
          "days_away": r["next_ex"]["days_away"],
          "last_ex_date": r["next_ex"]["last_ex_date"],
          # Assumes quarterly, which covers most US payers but not all.
          "estimated_payment": round(r["annual_income"] / 4, 2)
          if r.get("annual_income") else None}
         for r in payers if r.get("next_ex", {}).get("date")),
        key=lambda r: r["ex_div_date"])

    return {
        "positions": rows,
        "upcoming_ex_dates": upcoming,
        "summary": {
            "n_holdings": len(rows),
            "n_payers": len(payers),
            "n_non_payers": len(rows) - len(payers),
            "annual_income": round(total_income, 2),
            "monthly_income": round(total_income / 12, 2),
            "quarterly_income": round(total_income / 4, 2),
            "total_cost": round(total_cost, 2),
            "total_value": round(total_value, 2),
            # Portfolio-level versions of the same two yields.
            "yield_on_cost_pct": (round(total_income / total_cost * 100, 2)
                                  if total_cost else None),
            "current_yield_pct": (round(total_income / total_value * 100, 2)
                                  if total_value else None),
            "biggest_payer": (payers[0]["symbol"] if payers else None),
            "stretched_payers": [r["symbol"] for r in payers if r.get("stretched")],
            # Income concentration: if one holding is most of the income, a
            # single cut takes most of it.
            "top_payer_share_pct": (round(payers[0]["annual_income"]
                                          / total_income * 100, 1)
                                    if payers and total_income else None),
        },
    }


CSV_COLUMNS = ["symbol", "shares", "avg_cost", "price", "rate", "annual_income",
               "quarterly_income", "monthly_income", "yield_on_cost_pct",
               "current_yield_pct", "payout_ratio_pct", "ex_div_date"]


def to_csv_rows(rows: list[dict]) -> list[list]:
    out = [CSV_COLUMNS]
    for r in rows:
        out.append([r.get(c) if r.get(c) is not None else "" for c in CSV_COLUMNS])
    return out
