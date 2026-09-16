"""How much of your portfolio is really one bet. Pure math, no I/O, no AI.

Holding NVDA, MSFT and QQQ feels like three positions and behaves like one. The
correlation matrix is the cheapest way to make that undeniable, and the
diversification stats turn it into a single number you can't argue with:

  avg_correlation      mean pairwise correlation across the book
  effective_bets       how many INDEPENDENT positions the book behaves like.
                       Computed from the weighted variance ratio — if it says
                       1.8 while you hold eight names, you own about two bets.

Correlation is measured on daily log returns over a common set of dates, because
comparing series with different trading calendars (or a symbol that listed
mid-window) silently produces nonsense.
"""

from __future__ import annotations

import math

from .stats_util import log_returns, mean, stdev

# Above this, two holdings are close to interchangeable for risk purposes.
HIGH_CORRELATION = 0.75


def align_series(histories: dict) -> tuple[list[str], dict]:
    """Restrict every symbol's closes to the dates ALL of them share.

    Returns (dates, {symbol: closes}). Without this, a symbol with a shorter
    history quietly shifts every other series against it.
    """
    symbols = [s for s, h in histories.items()
               if (h or {}).get("dates") and (h or {}).get("closes")]
    if len(symbols) < 2:
        return [], {}

    common = set(histories[symbols[0]]["dates"])
    for s in symbols[1:]:
        common &= set(histories[s]["dates"])
    dates = sorted(common)
    if len(dates) < 20:
        return [], {}

    aligned = {}
    for s in symbols:
        by_date = dict(zip(histories[s]["dates"], histories[s]["closes"]))
        aligned[s] = [by_date[d] for d in dates]
    return dates, aligned


def pearson(a: list[float], b: list[float]) -> float | None:
    """Pearson correlation of two equal-length series."""
    n = min(len(a), len(b))
    if n < 3:
        return None
    a, b = a[:n], b[:n]
    ma, mb = mean(a), mean(b)
    sa, sb = stdev(a), stdev(b)
    if not sa or not sb:
        return None
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n)) / (n - 1)
    return cov / (sa * sb)


def correlation_matrix(histories: dict) -> dict:
    """Pairwise correlation of daily returns across the supplied symbols."""
    dates, aligned = align_series(histories)
    if not aligned:
        return {"available": False,
                "reason": "Need at least two symbols with 20+ overlapping "
                          "trading days."}

    symbols = sorted(aligned)
    rets = {s: log_returns(aligned[s]) for s in symbols}

    matrix = {}
    pairs = []
    for a in symbols:
        matrix[a] = {}
        for b in symbols:
            if a == b:
                matrix[a][b] = 1.0
                continue
            r = pearson(rets[a], rets[b])
            matrix[a][b] = round(r, 4) if r is not None else None
            if a < b and r is not None:
                pairs.append({"a": a, "b": b, "correlation": round(r, 4)})

    pairs.sort(key=lambda p: -p["correlation"])
    values = [p["correlation"] for p in pairs]

    return {
        "available": True,
        "symbols": symbols,
        "matrix": matrix,
        "pairs": pairs,
        "n_days": len(dates),
        "start": dates[0] if dates else None,
        "end": dates[-1] if dates else None,
        "avg_correlation": round(mean(values), 4) if values else None,
        "most_correlated": pairs[0] if pairs else None,
        "least_correlated": pairs[-1] if pairs else None,
        "high_pairs": [p for p in pairs if p["correlation"] >= HIGH_CORRELATION],
    }


def diversification(histories: dict, weights: dict | None = None) -> dict:
    """How many independent bets the book actually represents.

    effective_bets = (sum of weighted vols)^2 / portfolio variance. For a book of
    perfectly correlated holdings it collapses to 1 no matter how many tickers
    are in it; for uncorrelated equal-weight holdings it approaches the count.
    """
    dates, aligned = align_series(histories)
    if not aligned:
        return {"available": False,
                "reason": "Need at least two symbols with overlapping history."}

    symbols = sorted(aligned)
    rets = {s: log_returns(aligned[s]) for s in symbols}
    n = min(len(r) for r in rets.values())
    if n < 20:
        return {"available": False, "reason": "Not enough overlapping returns."}

    if weights:
        total = sum(abs(weights.get(s, 0)) for s in symbols) or 1.0
        w = {s: abs(weights.get(s, 0)) / total for s in symbols}
    else:
        w = {s: 1.0 / len(symbols) for s in symbols}

    vol = {s: stdev(rets[s][:n]) for s in symbols}

    # Portfolio variance = sum_i sum_j w_i w_j sigma_i sigma_j rho_ij
    var = 0.0
    for a in symbols:
        for b in symbols:
            r = 1.0 if a == b else (pearson(rets[a][:n], rets[b][:n]) or 0.0)
            var += w[a] * w[b] * vol[a] * vol[b] * r
    port_vol = math.sqrt(var) if var > 0 else 0.0

    # Weighted average of individual vols — what you'd get with no diversification.
    naive_vol = sum(w[s] * vol[s] for s in symbols)
    effective = (naive_vol / port_vol) ** 2 if port_vol > 0 else None

    # Two separate things can collapse a book to one bet, and they need
    # different fixes: everything moving together (correlation), or most of the
    # money sitting in one name (concentration). The inverse Herfindahl gives
    # the concentration-only count, so comparing it to effective_bets says which
    # problem you actually have.
    hhi = sum(w[s] ** 2 for s in symbols)
    weight_bets = 1.0 / hhi if hhi else None
    top_weight = max(w.values()) * 100 if w else None

    return {
        "available": True,
        "n_symbols": len(symbols),
        "n_days": n,
        "portfolio_volatility_pct": round(port_vol * math.sqrt(252) * 100, 2),
        "undiversified_volatility_pct": round(naive_vol * math.sqrt(252) * 100, 2),
        # How much volatility the mix actually removed.
        "diversification_benefit_pct": (round((1 - port_vol / naive_vol) * 100, 2)
                                        if naive_vol else None),
        "effective_bets": round(effective, 2) if effective else None,
        # What the count would be from position sizing alone, ignoring how the
        # holdings move together.
        "weight_effective_bets": round(weight_bets, 2) if weight_bets else None,
        "top_weight_pct": round(top_weight, 2) if top_weight else None,
        "limited_by": _limiting_factor(effective, weight_bets, len(symbols)),
        "weights": {s: round(w[s] * 100, 2) for s in symbols},
        "per_symbol_volatility_pct": {
            s: round(vol[s] * math.sqrt(252) * 100, 2) for s in symbols},
    }


def _limiting_factor(effective, weight_bets, n) -> str | None:
    """Is the book undiversified because of sizing, correlation, or both?"""
    if effective is None or weight_bets is None or n < 2:
        return None
    concentrated = weight_bets < n * 0.6
    correlated = effective < weight_bets * 0.75
    if concentrated and correlated:
        return "both"
    if concentrated:
        return "concentration"
    if correlated:
        return "correlation"
    return None


def verdict(corr: dict, div: dict) -> str:
    """One honest sentence naming WHY the book is or isn't diversified.

    Crucially it distinguishes the two causes. Saying "average correlation 0.09"
    next to "1.2 effective bets" reads as a contradiction; the real story is
    usually that one position is most of the money.
    """
    if not corr.get("available") or not div.get("available"):
        return "Not enough overlapping history to judge diversification."
    n = div["n_symbols"]
    eff = div.get("effective_bets")
    avg = corr.get("avg_correlation")
    if eff is None or avg is None:
        return "Diversification could not be computed."

    top = div.get("top_weight_pct")
    biggest = max(div.get("weights", {}), key=lambda s: div["weights"][s], default=None)
    cause = div.get("limited_by")
    worst = corr.get("most_correlated")

    if cause == "concentration":
        return (f"{n} holdings, but they behave like about {eff} independent "
                f"bet{'' if abs(eff - 1) < 0.05 else 's'} — because {biggest} is {top:.0f}% "
                f"of the money. The holdings themselves aren't especially "
                f"correlated (average {avg:.2f}); the position sizing is what "
                f"concentrates the risk.")
    if cause == "correlation":
        pair = (f" {worst['a']} and {worst['b']} move together at "
                f"{worst['correlation']:.2f}." if worst else "")
        return (f"{n} holdings sized reasonably evenly, but they behave like "
                f"about {eff} independent bets because they move together "
                f"(average correlation {avg:.2f}).{pair}")
    if cause == "both":
        return (f"{n} holdings behaving like about {eff} independent bets. Both "
                f"problems apply: {biggest} is {top:.0f}% of the money AND the "
                f"holdings move together (average correlation {avg:.2f}).")
    return (f"{n} holdings behaving like about {eff} independent bets "
            f"(average correlation {avg:.2f}) — reasonably diversified.")
