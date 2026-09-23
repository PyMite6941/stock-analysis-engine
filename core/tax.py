"""Form 8949 / Schedule D rows, and the wash sales that adjust them. No I/O.

`realized.py` already answers "what did I make?". This module answers the
harder question the IRS asks in April: "what goes on which line?" Two things
stand between the two answers.

**Wash sales.** Sell at a loss and buy the same thing back within 30 days
either side, and the loss is disallowed (IRC 1091) — you do not get to deduct
it. It is not lost forever: it is added to the basis of the shares you bought
back, so you get it later when you finally sell those. The 61-day window is
centred on the sale, so a purchase BEFORE the sale triggers it just as a
purchase after does, which is the part people get wrong.

  Only losses are affected. A gain is a gain no matter what you bought back.

**Box classification.** Every row lands in one of six buckets, split by holding
period and by whether the broker reported your cost basis to the IRS. We know
the holding period exactly; we cannot know the reporting status, so it is an
input with a sane default rather than a guess presented as fact. See `BOXES`.

### Crypto is deliberately excluded from wash-sale treatment

Section 1091 applies to "stocks or securities". Under current US law crypto is
property, not a security, so the wash-sale rule does not reach it — which is
why selling a coin at a loss and immediately rebuying it is a real strategy and
doing the same with a stock is not. Treating crypto as washable would overstate
the tax bill, so `wash_sales` skips it and says so in the output rather than
silently.

None of this is tax advice, and none of it is a substitute for your broker's
1099-B. It is a worksheet: it shows the arithmetic and where each number came
from so you can check it against the form you actually receive.
"""

from __future__ import annotations

from datetime import date, timedelta

from .assets import CRYPTO, classify
from .realized import _to_date, term_for

# IRC 1091: 30 days before through 30 days after, so 61 days including the
# sale date itself.
WASH_WINDOW_DAYS = 30

# Form 8949 boxes. Short-term rows go on Part I, long-term on Part II, and
# within each part the box says what the broker told the IRS.
BOXES = {
    ("short", True): "A",    # basis reported to the IRS (a "covered" security)
    ("short", False): "B",   # 1099-B received, basis NOT reported
    ("short", None): "C",    # no 1099-B at all
    ("long", True): "D",
    ("long", False): "E",
    ("long", None): "F",
}

# Most brokerage stock bought this decade is "covered", meaning basis is
# reported, so A/D is the right default for the common case. Crypto and older
# lots often are not, which is exactly why this is overridable.
DEFAULT_BASIS_REPORTED = True

WASH_CODE = "W"


def _fmt_date(value) -> str:
    """MM/DD/YYYY, the format the form itself uses. '' when unknown."""
    d = _to_date(value)
    return d.strftime("%m/%d/%Y") if d else ""


def _description(row: dict) -> str:
    """Column (a): "400 sh. NVDA" — quantity and what it was."""
    shares = row.get("shares") or 0
    qty = f"{shares:g}"
    return f"{qty} sh. {row.get('symbol', '')}".strip()


# ---------------------------------------------------------------------------
# Wash sales
# ---------------------------------------------------------------------------
def _purchase_records(open_lots, sales) -> list[dict]:
    """Every acquisition the app knows about, from both directions.

    A purchase is either a lot still open, or one implied by a sale: a sale row
    carries the date and price it was acquired at, so it is itself evidence of
    a buy. Without the second source, selling your entire position and buying
    back would look like no purchase ever happened.

    Each record keeps `source_id` so a sale is never treated as its own
    replacement — buying a lot cannot be the act that replaces selling it.
    """
    out = []
    for lot in open_lots or []:
        d = _to_date(getattr(lot, "opened", None) or (
            lot.get("opened") if isinstance(lot, dict) else None))
        if not d:
            continue
        sym = (getattr(lot, "symbol", None)
               or (lot.get("symbol") if isinstance(lot, dict) else "")).upper()
        shares = float(getattr(lot, "shares", None)
                       if not isinstance(lot, dict) else lot.get("shares") or 0)
        lot_id = (getattr(lot, "id", None)
                  if not isinstance(lot, dict) else lot.get("id")) or ""
        if shares <= 0:
            continue
        out.append({"symbol": sym, "date": d, "shares": shares,
                    "source": "open_lot", "source_id": str(lot_id),
                    "available": shares})

    for s in sales or []:
        d = _to_date(s.get("opened"))
        if not d:
            continue
        shares = float(s.get("shares") or 0)
        if shares <= 0:
            continue
        out.append({"symbol": str(s.get("symbol", "")).upper(), "date": d,
                    "shares": shares, "source": "closed_lot",
                    "source_id": str(s.get("id") or ""),
                    "sale_key": _sale_key(s), "available": shares})

    out.sort(key=lambda p: p["date"])
    return out


def _sale_key(sale: dict) -> str:
    """Identity for a sale row, used to stop it replacing itself.

    Sales carry an id only sometimes, so fall back to the fields that together
    pin down one row.
    """
    if sale.get("id"):
        return f"id:{sale['id']}"
    return "|".join(str(sale.get(k, "")) for k in
                    ("symbol", "shares", "opened", "closed", "cost_basis"))


def wash_sales(sales: list[dict], open_lots=None, as_of=None) -> dict:
    """Flag losses disallowed by the 30-day rule and size the adjustment.

    Returns {"rows": [...], "total_disallowed": float, "n_wash": int,
             "crypto_exempt": [symbols]} where each row mirrors the input sale
    with `wash_disallowed`, `wash_shares` and `replacements` added.

    Only losses are examined. Replacement shares are consumed earliest-first
    and only once, so buying back 100 shares cannot excuse two separate
    100-share losses.
    """
    sales = sales or []
    purchases = _purchase_records(open_lots, sales)
    crypto_exempt = set()
    rows = []

    # Oldest sale first: the disallowed loss attaches to the replacement, and
    # processing out of order would let a later sale claim a replacement the
    # earlier one was entitled to.
    ordered = sorted(sales, key=lambda s: (_to_date(s.get("closed")) or date.min))

    for sale in ordered:
        row = dict(sale)
        row["wash_disallowed"] = 0.0
        row["wash_shares"] = 0.0
        row["replacements"] = []

        pnl = float(sale.get("pnl") or 0)
        sold_on = _to_date(sale.get("closed"))
        symbol = str(sale.get("symbol", "")).upper()

        if pnl >= 0 or not sold_on:
            rows.append(row)
            continue

        # Crypto is property, not a security — 1091 does not reach it.
        if classify(symbol) == CRYPTO:
            crypto_exempt.add(symbol)
            row["wash_exempt"] = "crypto"
            rows.append(row)
            continue

        lo = sold_on - timedelta(days=WASH_WINDOW_DAYS)
        hi = sold_on + timedelta(days=WASH_WINDOW_DAYS)
        key = _sale_key(sale)

        shares_sold = float(sale.get("shares") or 0)
        need = shares_sold
        matched = 0.0
        used = []

        for p in purchases:
            if need <= 1e-9:
                break
            if p["symbol"] != symbol or p["available"] <= 1e-9:
                continue
            if not (lo <= p["date"] <= hi):
                continue
            # A lot cannot replace its own sale.
            if p.get("sale_key") == key:
                continue
            take = min(p["available"], need)
            p["available"] -= take
            need -= take
            matched += take
            used.append({"date": p["date"].isoformat(), "shares": round(take, 6),
                         "source": p["source"]})

        if matched > 1e-9 and shares_sold > 0:
            # Disallow the loss in proportion to how much of the position was
            # actually replaced — replacing half the shares disallows half.
            disallowed = abs(pnl) * (matched / shares_sold)
            row["wash_disallowed"] = round(disallowed, 2)
            row["wash_shares"] = round(matched, 6)
            row["replacements"] = used

        rows.append(row)

    return {
        "rows": rows,
        "n_wash": sum(1 for r in rows if r["wash_disallowed"] > 0),
        "total_disallowed": round(sum(r["wash_disallowed"] for r in rows), 2),
        "crypto_exempt": sorted(crypto_exempt),
    }


# ---------------------------------------------------------------------------
# Form 8949
# ---------------------------------------------------------------------------
FORM_8949_COLUMNS = [
    "box", "description", "date_acquired", "date_sold",
    "proceeds", "cost_basis", "code", "adjustment", "gain_loss",
]


def form_8949_rows(sales: list[dict], open_lots=None, year: int | None = None,
                   basis_reported: bool | None = DEFAULT_BASIS_REPORTED) -> dict:
    """Build the Form 8949 lines for one tax year.

    Column (h) is proceeds - basis + adjustment, which is the form's own
    arithmetic: a disallowed loss is entered as a POSITIVE adjustment in (g)
    because it moves the reported loss back toward zero.
    """
    flagged = wash_sales(sales, open_lots)
    rows = flagged["rows"]
    if year:
        rows = [r for r in rows if str(r.get("closed") or "")[:4] == str(year)]

    out = []
    for r in rows:
        term = r.get("term") or term_for(r.get("holding_days"))
        box = BOXES.get((term, basis_reported), "B" if term == "short" else "E")
        proceeds = round(float(r.get("proceeds") or 0), 2)
        cost = round(float(r.get("cost") or 0), 2)
        adj = round(float(r.get("wash_disallowed") or 0), 2)
        out.append({
            "box": box,
            "description": _description(r),
            "date_acquired": _fmt_date(r.get("opened")),
            "date_sold": _fmt_date(r.get("closed")),
            "proceeds": proceeds,
            "cost_basis": cost,
            "code": WASH_CODE if adj > 0 else "",
            "adjustment": adj if adj > 0 else "",
            "gain_loss": round(proceeds - cost + adj, 2),
            # Carried for the UI, not for the form itself.
            "symbol": r.get("symbol"),
            "term": term,
            "wash_shares": r.get("wash_shares") or 0,
            "replacements": r.get("replacements") or [],
            "wash_exempt": r.get("wash_exempt"),
        })

    out.sort(key=lambda r: (r["box"], r["date_sold"], r["description"]))
    return {
        "rows": out,
        "year": year,
        "basis_reported": basis_reported,
        "n_wash": sum(1 for r in out if r["code"] == WASH_CODE),
        "total_disallowed": round(
            sum(float(r["adjustment"] or 0) for r in out), 2),
        "crypto_exempt": flagged["crypto_exempt"],
    }


def schedule_d(form_rows: list[dict]) -> dict:
    """Schedule D totals: one subtotal per 8949 box, then the two part totals.

    Schedule D is a summary sheet — each box on 8949 becomes one line here, and
    the short and long totals are what actually flow to the 1040.
    """
    by_box: dict[str, dict] = {}
    for r in form_rows:
        b = by_box.setdefault(r["box"], {
            "box": r["box"],
            "term": r["term"],
            "n_rows": 0, "proceeds": 0.0, "cost_basis": 0.0,
            "adjustment": 0.0, "gain_loss": 0.0,
        })
        b["n_rows"] += 1
        b["proceeds"] += float(r["proceeds"] or 0)
        b["cost_basis"] += float(r["cost_basis"] or 0)
        b["adjustment"] += float(r["adjustment"] or 0)
        b["gain_loss"] += float(r["gain_loss"] or 0)

    lines = []
    for b in sorted(by_box.values(), key=lambda x: x["box"]):
        for k in ("proceeds", "cost_basis", "adjustment", "gain_loss"):
            b[k] = round(b[k], 2)
        lines.append(b)

    short = [b for b in lines if b["term"] == "short"]
    long_ = [b for b in lines if b["term"] == "long"]

    def total(group, key):
        return round(sum(b[key] for b in group), 2)

    short_net = total(short, "gain_loss")
    long_net = total(long_, "gain_loss")
    net = round(short_net + long_net, 2)

    return {
        "lines": lines,
        "short_term": {
            "proceeds": total(short, "proceeds"),
            "cost_basis": total(short, "cost_basis"),
            "adjustment": total(short, "adjustment"),
            "net": short_net,
        },
        "long_term": {
            "proceeds": total(long_, "proceeds"),
            "cost_basis": total(long_, "cost_basis"),
            "adjustment": total(long_, "adjustment"),
            "net": long_net,
        },
        "net_gain_loss": net,
        # A net capital loss is deductible against ordinary income only up to
        # $3,000 a year; the rest carries forward indefinitely. Worth stating,
        # because "I lost 20k so I deduct 20k" is a common and expensive
        # misunderstanding.
        "deductible_loss": round(max(net, -3000.0), 2) if net < 0 else None,
        "loss_carryforward": round(abs(net) - 3000.0, 2)
                             if net < -3000 else None,
    }


def to_csv_rows(form_rows: list[dict]) -> list[list]:
    """Form 8949 as a flat grid, columns in the order the form prints them."""
    out = [["Box", "Description of property", "Date acquired", "Date sold",
            "Proceeds", "Cost or other basis", "Code", "Amount of adjustment",
            "Gain or (loss)"]]
    for r in form_rows:
        out.append([r["box"], r["description"], r["date_acquired"],
                    r["date_sold"], r["proceeds"], r["cost_basis"],
                    r["code"], r["adjustment"], r["gain_loss"]])
    return out


def wash_csv_rows(form_rows: list[dict]) -> list[list]:
    """Just the wash sales, with the replacement buys that caused each one.

    A separate sheet because this is the part you will be asked to justify.
    """
    out = [["Symbol", "Date sold", "Shares washed", "Disallowed loss",
            "Replacement buys"]]
    for r in form_rows:
        if r["code"] != WASH_CODE:
            continue
        reps = "; ".join(f"{x['shares']:g} on {x['date']}"
                         for x in r.get("replacements", []))
        out.append([r.get("symbol"), r["date_sold"], r.get("wash_shares"),
                    r["adjustment"], reps])
    return out
