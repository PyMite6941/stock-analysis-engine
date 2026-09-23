"""Spreadsheet export/import. CSV is the default; XLSX is the richer option.

CSV first because it opens in everything and needs no dependency. XLSX exists
because a holdings file people actually maintain over months wants multiple
sheets, typed numbers and a frozen header row — things CSV cannot carry.

Import accepts either. Both paths converge on the same list-of-dicts so the
caller never branches on file type.
"""

from __future__ import annotations

import csv
import io
from typing import Any, Iterable

# openpyxl is optional: CSV must keep working on an install that skipped it.
try:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    XLSX_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only on minimal installs
    XLSX_AVAILABLE = False


class XlsxUnavailable(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------
def rows_to_csv(rows: Iterable[Iterable[Any]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    for row in rows:
        writer.writerow(["" if v is None else v for v in row])
    return buf.getvalue()


def dicts_to_rows(records: list[dict], columns: list[str]) -> list[list]:
    """Header row + one row per record, restricted to `columns`."""
    out = [list(columns)]
    for r in records:
        out.append([r.get(c) if r.get(c) is not None else "" for c in columns])
    return out


_HEADER_FILL = "FF1F2937"
_MONEY = '#,##0.00'
_PCT = '0.00"%"'

# Column-name suffix -> Excel number format. Keeps the formatting table in one
# place instead of scattered per-sheet conditionals.
_FORMATS = {
    "_pct": _PCT,
    "price": _MONEY, "cost": _MONEY, "cost_basis": _MONEY, "value": _MONEY,
    "pnl": _MONEY, "pivot": _MONEY, "atr": _MONEY, "vwap": _MONEY,
    "open": _MONEY, "high": _MONEY, "low": _MONEY, "close": _MONEY,
    "shares": '#,##0.####', "volume": '#,##0',
}


def _format_for(column: str) -> str | None:
    col = str(column).lower()
    for suffix, fmt in _FORMATS.items():
        if col.endswith(suffix) or col == suffix:
            return fmt
    return None


def sheets_to_xlsx(sheets: dict[str, list[list]]) -> bytes:
    """Write {sheet_name: rows} to an .xlsx byte string.

    Row 0 of each sheet is treated as the header: bold, filled, frozen, and used
    to pick each column's number format.
    """
    if not XLSX_AVAILABLE:
        raise XlsxUnavailable(
            "XLSX export needs openpyxl (pip install openpyxl). CSV still works.")

    wb = Workbook()
    wb.remove(wb.active)

    for name, rows in sheets.items():
        # Excel sheet names cap at 31 chars and reject []:*?/\
        safe = "".join(c for c in str(name) if c not in "[]:*?/\\")[:31] or "Sheet"
        ws = wb.create_sheet(safe)
        if not rows:
            continue

        header = [str(h) for h in rows[0]]
        ws.append(header)
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFFFF")
            cell.fill = PatternFill("solid", fgColor=_HEADER_FILL)
            cell.alignment = Alignment(horizontal="center")

        for row in rows[1:]:
            ws.append(["" if v is None else v for v in row])

        formats = [_format_for(h) for h in header]
        for col_idx, fmt in enumerate(formats, start=1):
            letter = get_column_letter(col_idx)
            width = max([len(header[col_idx - 1])]
                        + [len(str(r[col_idx - 1])) for r in rows[1:]
                           if col_idx - 1 < len(r)] or [10])
            ws.column_dimensions[letter].width = min(max(width + 3, 10), 42)
            if fmt:
                for cell in ws[letter][1:]:
                    cell.number_format = fmt

        ws.freeze_panes = "A2"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
# Accepted header spellings -> (canonical field, priority). Covers what brokers
# actually emit, so an exported Fidelity/Schwab CSV imports without hand-editing.
#
# Priority breaks ties when one file has several columns for the same field.
# Our own export has BOTH "cost_basis" and "price" (current mark), and "price"
# is only a cost-basis alias as a last resort — hence the low score on it.
_ALIASES = {
    "symbol": ("symbol", 10), "ticker": ("symbol", 9), "stock": ("symbol", 5),
    "security": ("symbol", 4), "instrument": ("symbol", 4),

    "shares": ("shares", 10), "quantity": ("shares", 9), "qty": ("shares", 9),
    "units": ("shares", 6), "no of shares": ("shares", 8), "amount": ("shares", 2),

    # Per-share cost. Real broker spellings — Fidelity writes "Average Cost
    # Basis", Vanguard writes "Share Price".
    "cost basis per share": ("cost_basis", 10),
    "average cost basis": ("cost_basis", 10),
    "cost per share": ("cost_basis", 10),
    "price per share": ("cost_basis", 10),
    "share price": ("cost_basis", 9),
    "average cost": ("cost_basis", 9), "avg cost": ("cost_basis", 9),
    "avg price": ("cost_basis", 9), "average price": ("cost_basis", 9),
    "unit cost": ("cost_basis", 9),
    "purchase price": ("cost_basis", 8), "buy price": ("cost_basis", 8),
    "entry price": ("cost_basis", 7), "entry": ("cost_basis", 6),
    # AMBIGUOUS: Schwab's "Cost Basis" is the TOTAL for the lot, Fidelity's is
    # per share. Captured here, then resolved against the price column by
    # _resolve_cost_basis below.
    "cost basis": ("cost_basis", 5),
    "price": ("cost_basis", 1),   # only if nothing better is present

    # Unambiguously the whole position, never per share. Used to derive a
    # per-share basis when that's all the file gives us.
    "total cost": ("total_cost", 10),
    "total cost basis": ("total_cost", 10),
    "cost basis total": ("total_cost", 10),
    "total amount": ("total_cost", 6),

    # Current price, captured only to sanity-check the cost basis. Never used
    # as the cost basis itself — it is today's price, not what was paid.
    "last price": ("price_hint", 10),
    "current price": ("price_hint", 10),
    "market price": ("price_hint", 9),
    "last": ("price_hint", 5),

    "opened": ("opened", 10), "buy date": ("opened", 9),
    "purchase date": ("opened", 9), "trade date": ("opened", 9),
    "acquired": ("opened", 8), "date": ("opened", 4),

    "note": ("note", 10), "notes": ("note", 10),
    "comment": ("note", 6), "memo": ("note", 6),

    "exit_plan": ("exit_plan", 10), "exit plan": ("exit_plan", 10),
    "sell plan": ("exit_plan", 9), "exit strategy": ("exit_plan", 9),
    "thesis": ("exit_plan", 5),
}


def _lookup(header: str) -> tuple[str, int] | None:
    key = str(header or "").strip().lower()
    return _ALIASES.get(key.replace("_", " ").strip()) or _ALIASES.get(key)


def _canonical(header: str) -> str | None:
    hit = _lookup(header)
    return hit[0] if hit else None


def _map_header(header: list) -> dict[int, str]:
    """Column index -> canonical field, keeping the best alias per field.

    Losing columns are dropped entirely rather than overwriting the winner,
    which is what made a round-tripped export read its own "price" column as
    the cost basis.
    """
    best: dict[str, tuple[int, int]] = {}   # field -> (priority, column index)
    losers: list[tuple[int, str]] = []      # (index, header) that lost a contest
    for i, h in enumerate(header):
        hit = _lookup(h)
        if not hit:
            continue
        field, priority = hit
        if field not in best or priority > best[field][0]:
            if field in best:
                losers.append((best[field][1], str(header[best[field][1]])))
            best[field] = (priority, i)
        else:
            losers.append((i, str(h)))

    mapping = {idx: field for field, (_, idx) in best.items()}

    # A price column that LOST the cost-basis contest is still valuable: it is
    # the yardstick that says whether the winning "Cost Basis" was per-share or
    # a lot total. Schwab emits exactly this shape (Price + Cost Basis), and
    # dropping the loser meant the total went in as a per-share figure — a
    # 25-share position imported at 25x its real cost, silently.
    if "price_hint" not in best:
        for idx, raw in losers:
            name = str(raw or "").strip().lower().replace("_", " ")
            if name in ("price", "last", "last price", "current price",
                        "market price", "share price"):
                mapping[idx] = "price_hint"
                break

    return mapping


def _clean_number(v: Any) -> float | None:
    """Parse a number out of spreadsheet junk: $1,234.50, (12.00), 15%."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return None
    negative = s.startswith("(") and s.endswith(")")
    s = s.strip("()").replace("$", "").replace(",", "").replace("%", "").strip()
    try:
        n = float(s)
    except ValueError:
        return None
    return -n if negative else n


def _resolve_cost_basis(rec: dict) -> None:
    """Turn whatever the file gave us into a PER-SHARE cost basis.

    "Cost Basis" means different things at different brokers: Schwab writes the
    total for the lot, Fidelity writes per share. Getting it wrong is silent and
    severe — importing Schwab's total as per-share overstated a 25-share
    position by 25x, and the number looks perfectly plausible on screen.

    Resolved by arithmetic rather than by guessing from the header:
      * an explicit total column divided by the share count always wins;
      * otherwise, if dividing the ambiguous value by shares lands it near a
        price column while the raw value is nowhere near it, it was a total.
    """
    shares = rec.get("shares")
    if not shares:
        return

    total = rec.pop("total_cost", None)
    hint = rec.pop("price_hint", None)
    basis = rec.get("cost_basis")

    # An unambiguous total column is the most reliable signal available.
    if total and (basis is None or rec.get("_basis_ambiguous")):
        rec["cost_basis"] = abs(total / shares)
        rec.pop("_basis_ambiguous", None)
        return

    if basis is None or not hint or hint <= 0:
        rec.pop("_basis_ambiguous", None)
        return

    per_share = abs(basis / shares)
    # Within 50% of the quoted price counts as "this is a per-share number".
    near = abs(per_share - hint) / hint < 0.5
    far = abs(abs(basis) - hint) / hint > 0.5
    if near and far:
        rec["cost_basis"] = per_share
    rec.pop("_basis_ambiguous", None)


def sniff_delimiter(text: str) -> str:
    """Pick the delimiter from the header line.

    Excel writes semicolons in locales where the comma is the decimal
    separator, and plenty of exports are tab-separated. Sniffing costs nothing
    and turns a hard failure into a successful import.
    """
    first = next((ln for ln in text.splitlines() if ln.strip()), "")
    counts = {d: first.count(d) for d in (",", ";", "\t", "|")}
    best = max(counts, key=counts.get)
    return best if counts[best] else ","


def _rows_to_positions(rows: list[list]) -> list[dict]:
    """Map a header row + data rows onto position dicts, skipping junk rows."""
    if not rows:
        return []
    header = rows[0]
    mapping = _map_header(header)
    if "symbol" not in mapping.values():
        raise ValueError(_NO_HEADER)
    # "Cost Basis" needs resolving; a precise per-share header does not.
    ambiguous_basis = any(
        str(h or "").strip().lower() in ("cost basis", "price")
        for i, h in enumerate(header) if mapping.get(i) == "cost_basis")

    out = []
    for row in rows[1:]:
        rec: dict = {}
        for i, field in mapping.items():
            if not field or i >= len(row):
                continue
            val = row[i]
            if field in ("shares", "cost_basis", "total_cost", "price_hint"):
                rec[field] = _clean_number(val)
            elif field == "opened" and val is not None:
                # Excel hands back datetimes. Keep the clock time when there is
                # one — day traders open and close inside a single session, and
                # truncating to the date would erase the holding period.
                if hasattr(val, "strftime"):
                    has_clock = any(getattr(val, a, 0) for a in ("hour", "minute", "second"))
                    rec[field] = val.strftime("%Y-%m-%d %H:%M" if has_clock else "%Y-%m-%d")
                else:
                    rec[field] = str(val).strip()[:16]
            elif val is not None and str(val).strip():
                rec[field] = str(val).strip()

        if ambiguous_basis:
            rec["_basis_ambiguous"] = True
        _resolve_cost_basis(rec)

        sym = str(rec.get("symbol") or "").strip().upper()
        if not sym or rec.get("shares") is None or rec.get("cost_basis") is None:
            continue
        rec["symbol"] = sym
        rec["cost_basis"] = round(rec["cost_basis"], 6)
        out.append(rec)
    return out


_NO_HEADER = ("No symbol/ticker column found. Expected a header row with at "
              "least 'symbol', 'shares' and 'cost_basis' (or 'price').")


def _skip_to_header(rows: list[list]) -> list[list]:
    """Drop preamble rows until one looks like a header.

    Raises rather than returning [] when nothing matches, so the user gets the
    real reason instead of a bare "no usable rows".
    """
    while rows and not any(_canonical(h) for h in rows[0]):
        rows.pop(0)
    if not rows:
        raise ValueError(_NO_HEADER)
    return rows


def parse_positions_file(filename: str, content: bytes) -> list[dict]:
    """Parse an uploaded holdings CSV or XLSX into position dicts."""
    name = (filename or "").lower()
    # A real .xlsx always starts with the ZIP magic bytes. Routing on the
    # extension alone means a CSV someone saved as .xlsx — or exported from a
    # tool that mislabels it — dies with "File is not a zip file", which tells
    # the user nothing useful about a file that is perfectly importable.
    looks_xlsx = content[:2] == b"PK"

    if name.endswith((".xlsx", ".xlsm")) or looks_xlsx:
        if not looks_xlsx:
            return _parse_csv_bytes(content)      # mislabelled; it's text
        if not XLSX_AVAILABLE:
            raise XlsxUnavailable(
                "XLSX import needs openpyxl (pip install openpyxl). "
                "Re-save the file as CSV and try again.")
        wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
        rows = [list(r) for r in wb[wb.sheetnames[0]].iter_rows(values_only=True)]
        return _rows_to_positions(_skip_to_header(rows))

    return _parse_csv_bytes(content)


def _parse_csv_bytes(content: bytes) -> list[dict]:
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text), delimiter=sniff_delimiter(text))
    rows = [r for r in reader if any(str(c).strip() for c in r)]
    return _rows_to_positions(_skip_to_header(rows))
