"""Dated events ahead: earnings and ex-dividends. No I/O, no AI.

The forecast cone in `forecast.py` models a stock as a random walk. That is a
fair description of a quiet week and a bad one for the night a company reports
earnings, which is the single most common reason a position gaps 10% while you
are asleep. The cone cannot know; this module is how the UI finds out.

Two event types, because they are the two dates that actually move money:

  earnings      the report date. Volatility clusters around it in both
                directions, so it is a heads-up, never a signal.
  ex_dividend   buy before this date and you receive the dividend; buy on or
                after it and the seller keeps it. The price drops by roughly
                the dividend that morning, which looks like a loss and is not.

Everything here is derived from dates already fetched for the fundamentals
panel, so a calendar costs no extra requests beyond the symbols themselves.
"""

from __future__ import annotations

from datetime import date, datetime

EARNINGS, EX_DIVIDEND = "earnings", "ex_dividend"

# How close counts as imminent. Three days is roughly the point where holding
# through the event becomes a decision rather than a detail.
IMMINENT_DAYS = 3
SOON_DAYS = 14


def _parse(value) -> date | None:
    """Accept an ISO date, a datetime, or a full ISO timestamp."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
                "%Y/%m/%d"):
        try:
            return datetime.strptime(text[:len(fmt) + 2].strip(), fmt).date()
        except ValueError:
            continue
    # Last resort: a leading YYYY-MM-DD inside a longer string.
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def symbols_from(symbols, positions) -> list[str]:
    """Union of explicitly requested symbols and everything held."""
    out = {str(s).strip().upper() for s in (symbols or []) if str(s).strip()}
    for p in positions or []:
        sym = p.get("symbol") if isinstance(p, dict) else getattr(p, "symbol", None)
        if sym:
            out.add(str(sym).strip().upper())
    return sorted(out)


def urgency(days: int | None) -> str:
    """How loudly the UI should say it. Past events are never urgent."""
    if days is None or days < 0:
        return "past"
    if days <= IMMINENT_DAYS:
        return "imminent"
    if days <= SOON_DAYS:
        return "soon"
    return "scheduled"


def _label(kind: str, days: int | None) -> str:
    what = "Earnings" if kind == EARNINGS else "Ex-dividend"
    if days is None:
        return what
    if days < 0:
        return f"{what} {abs(days)}d ago"
    if days == 0:
        return f"{what} today"
    if days == 1:
        return f"{what} tomorrow"
    return f"{what} in {days}d"


def event_for(symbol: str, kind: str, when, as_of=None,
              amount: float | None = None) -> dict | None:
    """One calendar entry, or None when the date is missing or unparseable."""
    d = _parse(when)
    if not d:
        return None
    ref = _parse(as_of) or date.today()
    days = (d - ref).days
    row = {
        "symbol": symbol.upper(),
        "kind": kind,
        "date": d.isoformat(),
        "days_away": days,
        "urgency": urgency(days),
        "label": _label(kind, days),
    }
    if amount is not None:
        row["amount"] = amount
    return row


def build_calendar(fundamentals: dict, within_days: int = 90,
                   as_of=None) -> dict:
    """Turn {symbol: Fundamentals} into a sorted forward calendar.

    `fundamentals` values may be None — a provider failure for one symbol drops
    that symbol from the calendar rather than the whole page.

    Past events are excluded: this answers "what is coming", and a report from
    last month is history, not a warning.
    """
    rows = []
    for symbol, f in (fundamentals or {}).items():
        if f is None:
            continue
        get = (lambda k: f.get(k)) if isinstance(f, dict) else (
            lambda k: getattr(f, k, None))

        e = event_for(symbol, EARNINGS, get("earnings_date"), as_of)
        if e:
            # An estimated date can move by a week, so say which kind it is
            # rather than presenting a guess with the same confidence as a
            # date the company actually announced.
            if get("earnings_date_estimated"):
                e["estimated"] = True
                e["label"] += " (est.)"
            rows.append(e)
        x = event_for(symbol, EX_DIVIDEND, get("ex_dividend_date"), as_of,
                      amount=get("forward_dividend"))
        if x:
            rows.append(x)

    upcoming = [r for r in rows
                if 0 <= (r["days_away"] or 0) <= within_days]
    upcoming.sort(key=lambda r: (r["days_away"], r["symbol"], r["kind"]))

    by_symbol: dict[str, list[dict]] = {}
    for r in upcoming:
        by_symbol.setdefault(r["symbol"], []).append(r)

    return {
        "events": upcoming,
        "by_symbol": by_symbol,
        "n": len(upcoming),
        "within_days": within_days,
        "n_imminent": sum(1 for r in upcoming if r["urgency"] == "imminent"),
        "next": upcoming[0] if upcoming else None,
    }


def badges(calendar: dict) -> dict:
    """symbol -> the single most urgent event, for a one-glance table badge.

    A row in a holdings table has space for one marker, so it gets the nearest
    event rather than a list nobody can read at that size.
    """
    out = {}
    for symbol, rows in (calendar.get("by_symbol") or {}).items():
        if rows:
            out[symbol] = rows[0]
    return out


CSV_COLUMNS = ["symbol", "kind", "date", "days_away", "urgency", "amount"]


def to_csv_rows(rows: list[dict]) -> list[list]:
    out = [CSV_COLUMNS]
    for r in rows:
        out.append([r.get(c) if r.get(c) is not None else "" for c in CSV_COLUMNS])
    return out
