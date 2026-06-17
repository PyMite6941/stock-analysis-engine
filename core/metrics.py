"""Analysis math over price history. Pure functions, no I/O, no AI.

Everything here is deterministic given the input series, so the offline
(Streamlit) path produces exactly the same numbers as the online (FastAPI) path.
"""

from __future__ import annotations

import math
from .data import History, Quote


def _pct_returns(closes: list[float]) -> list[float]:
    return [(closes[i] / closes[i - 1] - 1.0)
            for i in range(1, len(closes)) if closes[i - 1]]


def total_return_pct(closes: list[float]) -> float:
    if len(closes) < 2 or not closes[0]:
        return 0.0
    return (closes[-1] / closes[0] - 1.0) * 100


def annualized_volatility_pct(closes: list[float]) -> float:
    """Std-dev of daily returns, scaled to annual (~252 trading days)."""
    rets = _pct_returns(closes)
    if len(rets) < 2:
        return 0.0
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var) * math.sqrt(252) * 100


def max_drawdown_pct(closes: list[float]) -> float:
    """Largest peak-to-trough drop, as a negative percent."""
    peak, worst = float("-inf"), 0.0
    for c in closes:
        peak = max(peak, c)
        if peak:
            worst = min(worst, (c / peak - 1.0))
    return worst * 100


def moving_average(closes: list[float], window: int) -> float | None:
    if len(closes) < window:
        return None
    return sum(closes[-window:]) / window


def analyze_history(hist: History) -> dict:
    """Per-symbol stat block from a price series."""
    closes = hist.closes
    ma50 = moving_average(closes, 50)
    ma200 = moving_average(closes, 200)
    last = closes[-1] if closes else None
    return {
        "symbol": hist.symbol,
        "points": len(closes),
        "last": last,
        "total_return_pct": round(total_return_pct(closes), 2),
        "annualized_volatility_pct": round(annualized_volatility_pct(closes), 2),
        "max_drawdown_pct": round(max_drawdown_pct(closes), 2),
        "ma50": round(ma50, 4) if ma50 else None,
        "ma200": round(ma200, 4) if ma200 else None,
        # simple trend signal: price vs the two moving averages
        "trend": _trend_signal(last, ma50, ma200),
    }


def _trend_signal(last, ma50, ma200) -> str:
    if last is None or ma50 is None:
        return "insufficient-data"
    if ma200 is not None:
        if last > ma50 > ma200:
            return "strong-uptrend"
        if last < ma50 < ma200:
            return "strong-downtrend"
    return "uptrend" if last > ma50 else "downtrend"


def performance(dates: list[str], closes: list[float]) -> dict:
    """Trailing returns over standard windows (% change to the latest close)."""
    if len(closes) < 2:
        return {}
    last = closes[-1]
    n = len(closes)

    def ret(idx):
        if idx is None or idx < 0 or idx >= n or not closes[idx]:
            return None
        return round((last / closes[idx] - 1) * 100, 2)

    # ~21 trading days per month.
    out = {
        "1W": ret(n - 1 - 5), "1M": ret(n - 1 - 21), "3M": ret(n - 1 - 63),
        "6M": ret(n - 1 - 126), "1Y": ret(0),
    }
    last_year = dates[-1][:4]
    ytd_idx = next((i for i, d in enumerate(dates) if d[:4] == last_year), None)
    out["YTD"] = ret(ytd_idx)
    return out


def portfolio_summary(quotes: list[Quote], analyses: list[dict]) -> dict:
    """Cross-symbol roll-up — the headline numbers for the dashboard top bar."""
    pes = [q.pe for q in quotes if q.pe]
    vols = [a["annualized_volatility_pct"] for a in analyses if a.get("points", 0) > 1]
    rets = [a["total_return_pct"] for a in analyses if a.get("points", 0) > 1]
    gainers = sum(1 for q in quotes if q.change_pct > 0)
    return {
        "n_symbols": len(quotes),
        "gainers": gainers,
        "losers": len(quotes) - gainers,
        "avg_pe": round(sum(pes) / len(pes), 2) if pes else None,
        "avg_total_return_pct": round(sum(rets) / len(rets), 2) if rets else None,
        "avg_volatility_pct": round(sum(vols) / len(vols), 2) if vols else None,
        "most_volatile": _argextreme(analyses, "annualized_volatility_pct", max),
        "best_performer": _argextreme(analyses, "total_return_pct", max),
        "worst_performer": _argextreme(analyses, "total_return_pct", min),
    }


def _argextreme(analyses: list[dict], key: str, fn):
    candidates = [a for a in analyses if a.get("points", 0) > 1]
    if not candidates:
        return None
    return fn(candidates, key=lambda a: a[key])["symbol"]
