"""The book as one object: concentration, clusters, and portfolio risk. No I/O.

Everywhere else in this project measures one symbol at a time. That is the
wrong unit for the only question that changes behaviour — *what should I buy
next?* — because the risk of adding NVDA depends entirely on what you already
hold.

Three answers here, in rising order of how uncomfortable they are:

  **Concentration.** How much of the book is in its largest line, and the
  Herfindahl index over weights, which is the honest version of "how many
  positions do you have". Ten holdings where one is 80% is a one-stock
  portfolio with decoration.

  **Clusters.** Groups of holdings whose daily returns move together above
  `correlation.HIGH_CORRELATION`. These are the positions that will all be red
  on the same morning — diversification you think you have and do not.

  **Portfolio risk.** Volatility, drawdown, Sharpe and VaR computed on the
  weighted portfolio return series rather than averaged across holdings.
  Averaging per-symbol risk overstates it, because it throws away the
  cancellation that owning different things buys you.

Weights are of MARKET value, not cost — risk lives in what you hold now, not
what you paid. Unpriced holdings are excluded and counted, so a missing quote
shrinks the sample instead of quietly reporting a position as worthless.
"""

from __future__ import annotations

import math

from .correlation import (HIGH_CORRELATION, align_series, correlation_matrix,
                          diversification, pearson)
from .stats_util import log_returns, mean, stdev

TRADING_DAYS = 252

# A line this size dominates the book's outcome regardless of what else is in
# it. Not a rule, a threshold for saying so out loud.
CONCENTRATED_WEIGHT_PCT = 25.0

# Herfindahl over weights. 1/n for n equal positions, so 0.25 is "behaves like
# four equally-sized holdings" no matter how many rows the table has.
HHI_CONCENTRATED = 0.25


def weights_from(valued: dict) -> dict:
    """symbol -> share of market value, aggregated across lots of one symbol."""
    rows = [r for r in (valued.get("positions") or [])
            if r.get("market_value") is not None]
    total = sum(r["market_value"] for r in rows)
    if total <= 0:
        return {}
    out: dict[str, float] = {}
    for r in rows:
        out[r["symbol"]] = out.get(r["symbol"], 0.0) + r["market_value"] / total
    return out


def concentration(weights: dict) -> dict:
    """Herfindahl index, top-line share, and how many bets that really is."""
    if not weights:
        return {"available": False, "reason": "Nothing priced to weigh."}

    ordered = sorted(weights.items(), key=lambda kv: kv[1], reverse=True)
    hhi = sum(w * w for _, w in ordered)
    # 1/HHI is the "effective number of positions" — the count of equally
    # weighted holdings that would give the same concentration.
    effective_n = 1.0 / hhi if hhi > 0 else None
    top_sym, top_w = ordered[0]
    top3 = sum(w for _, w in ordered[:3])

    return {
        "available": True,
        "n_positions": len(ordered),
        "hhi": round(hhi, 4),
        "effective_positions": round(effective_n, 2) if effective_n else None,
        "largest": {"symbol": top_sym, "weight_pct": round(top_w * 100, 2)},
        "top3_weight_pct": round(top3 * 100, 2),
        "concentrated": bool(top_w * 100 >= CONCENTRATED_WEIGHT_PCT
                             or hhi >= HHI_CONCENTRATED),
        "weights_pct": {s: round(w * 100, 2) for s, w in ordered},
    }


def clusters(histories: dict, threshold: float = HIGH_CORRELATION) -> list[list[str]]:
    """Groups of symbols that move together above `threshold`.

    Single-link clustering: A and C land in one group if each is correlated
    with B, even if not with each other. That is the right shape for risk —
    what matters is whether one shock reaches the whole group, not whether
    every pair is individually tight.
    """
    dates, aligned = align_series(histories)
    symbols = sorted(aligned)
    if len(symbols) < 2:
        return []

    rets = {s: log_returns(aligned[s]) for s in symbols}
    n = min(len(r) for r in rets.values())
    if n < 20:
        return []

    # Union-find over the pairs that clear the threshold.
    parent = {s: s for s in symbols}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i, a in enumerate(symbols):
        for b in symbols[i + 1:]:
            r = pearson(rets[a][:n], rets[b][:n])
            if r is not None and r >= threshold:
                union(a, b)

    groups: dict[str, list[str]] = {}
    for s in symbols:
        groups.setdefault(find(s), []).append(s)

    # A "cluster" of one is just a holding; only groups are interesting.
    return sorted((sorted(g) for g in groups.values() if len(g) > 1),
                  key=len, reverse=True)


def _align(histories: dict) -> tuple[list[str], dict]:
    """Like correlation.align_series, but valid for a single symbol too.

    `align_series` returns nothing below two symbols, which is right for a
    correlation matrix and wrong here: a one-holding portfolio still has risk,
    and refusing to measure it would blank the panel for anyone starting out.
    """
    symbols = [s for s, h in (histories or {}).items()
               if (h or {}).get("dates") and (h or {}).get("closes")]
    if not symbols:
        return [], {}
    if len(symbols) == 1:
        s = symbols[0]
        return list(histories[s]["dates"]), {s: list(histories[s]["closes"])}
    return align_series(histories)


def portfolio_series(histories: dict, weights: dict) -> tuple[list[str], list[float]]:
    """A single weighted return series for the book.

    Built from returns rather than prices because the holdings have wildly
    different share prices, and a price-weighted sum would just track whichever
    stock happens to trade in the hundreds.
    """
    dates, aligned = _align(histories)
    symbols = [s for s in sorted(aligned) if s in weights]
    if not symbols or len(dates) < 2:
        return [], []

    total = sum(weights[s] for s in symbols) or 1.0
    w = {s: weights[s] / total for s in symbols}

    rets = {s: log_returns(aligned[s]) for s in symbols}
    n = min(len(r) for r in rets.values())
    if n < 2:
        return [], []

    combined = [sum(w[s] * rets[s][i] for s in symbols) for i in range(n)]
    return dates[-n:], combined


def _drawdown_from_returns(rets: list[float]) -> float:
    """Worst peak-to-trough decline of the compounded series, as a percent."""
    level, peak, worst = 1.0, 1.0, 0.0
    for r in rets:
        level *= math.exp(r)
        peak = max(peak, level)
        if peak > 0:
            worst = min(worst, level / peak - 1.0)
    return round(worst * 100, 2)


def risk_stats(rets: list[float], rf_annual: float = 0.0) -> dict:
    """Annualised volatility, Sharpe, historical VaR/CVaR, and drawdown."""
    if len(rets) < 20:
        return {"available": False,
                "reason": "Need at least 20 overlapping days of history."}

    mu = mean(rets)
    sd = stdev(rets)
    ann_vol = sd * math.sqrt(TRADING_DAYS) * 100
    ann_ret = (math.exp(mu * TRADING_DAYS) - 1) * 100

    sharpe = None
    if sd > 0:
        sharpe = ((mu * TRADING_DAYS) - rf_annual) / (sd * math.sqrt(TRADING_DAYS))

    downside = [r for r in rets if r < 0]
    sortino = None
    if downside and len(downside) > 1:
        dsd = stdev(downside)
        if dsd > 0:
            sortino = (mu * TRADING_DAYS) / (dsd * math.sqrt(TRADING_DAYS))

    # Historical VaR: the 5th percentile daily move, i.e. "one day in twenty
    # is worse than this". Empirical rather than normal, because real return
    # distributions have fatter tails than the normal curve allows.
    ordered = sorted(rets)
    idx = max(0, int(len(ordered) * 0.05) - 1)
    var95 = ordered[idx]
    tail = ordered[:idx + 1]
    cvar95 = mean(tail) if tail else var95

    return {
        "available": True,
        "n_days": len(rets),
        "annual_return_pct": round(ann_ret, 2),
        "annual_volatility_pct": round(ann_vol, 2),
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "sortino": round(sortino, 2) if sortino is not None else None,
        "var_95_pct": round((math.exp(var95) - 1) * 100, 2),
        "cvar_95_pct": round((math.exp(cvar95) - 1) * 100, 2),
        "max_drawdown_pct": _drawdown_from_returns(rets),
    }


def verdict(conc: dict, clus: list[list[str]], div: dict) -> str:
    """One sentence naming the binding constraint, not a grade.

    Ordered by which fact would change a decision first: a single dominant line
    beats a correlated cluster beats a low effective-bet count, because that is
    the order in which they are fixable.
    """
    if not conc.get("available"):
        return "Not enough priced holdings to assess portfolio risk."

    largest = conc["largest"]
    if largest["weight_pct"] >= CONCENTRATED_WEIGHT_PCT:
        base = (f"{largest['symbol']} is {largest['weight_pct']:.0f}% of the "
                f"book — its result is most of your result.")
    elif conc["hhi"] >= HHI_CONCENTRATED:
        base = (f"Weights behave like {conc['effective_positions']:.1f} equal "
                f"positions across {conc['n_positions']} holdings.")
    else:
        base = (f"Sizing is even — {conc['effective_positions']:.1f} effective "
                f"positions from {conc['n_positions']} holdings.")

    if clus:
        biggest = clus[0]
        base += (f" {', '.join(biggest)} move together, so they are closer to "
                 f"one position than {len(biggest)}.")
    elif div.get("available") and div.get("effective_bets"):
        base += (f" Correlation leaves about {div['effective_bets']:.1f} "
                 f"independent bets.")
    return base


def portfolio_risk(valued: dict, histories: dict, period: str = "1y") -> dict:
    """Everything above, assembled for one API response."""
    weights = weights_from(valued)
    conc = concentration(weights)

    corr = correlation_matrix(histories) if len(histories) > 1 else {
        "available": False, "reason": "Need at least two symbols."}
    div = diversification(histories, weights) if len(histories) > 1 else {
        "available": False, "reason": "Need at least two symbols."}
    clus = clusters(histories) if len(histories) > 1 else []

    dates, rets = portfolio_series(histories, weights)
    stats = risk_stats(rets) if rets else {
        "available": False, "reason": "No overlapping history for these holdings."}

    summary = valued.get("summary") or {}
    return {
        "period": period,
        "concentration": conc,
        "correlation": corr,
        "diversification": div,
        "clusters": clus,
        "portfolio": stats,
        "verdict": verdict(conc, clus, div),
        "n_unpriced": summary.get("n_unpriced", 0),
        "total_value": summary.get("total_value"),
    }
