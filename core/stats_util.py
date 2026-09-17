"""Small statistical helpers shared by the forecast/day-trade modules.

Kept separate from metrics.py so the forecasting math stays readable, and so the
offline Streamlit path can import these without pulling in anything else.
Pure functions, no I/O, no third-party deps.
"""

from __future__ import annotations

import math


def log_returns(closes: list[float]) -> list[float]:
    """Continuously-compounded returns. Skips non-positive or non-finite prices.

    isfinite matters as much as the positivity check: `inf > 0` is True, so an
    infinite price slipped through and made `cur / prev` collapse to 0.0, and
    math.log(0.0) raises ValueError rather than returning -inf. One corrupt bar
    could therefore crash every downstream statistic.
    """
    out = []
    for i in range(1, len(closes)):
        prev, cur = closes[i - 1], closes[i]
        if (prev and cur and math.isfinite(prev) and math.isfinite(cur)
                and prev > 0 and cur > 0):
            r = math.log(cur / prev)
            if math.isfinite(r):
                out.append(r)
    return out


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def stdev(xs: list[float]) -> float:
    """Sample standard deviation (n-1)."""
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def percentile(xs: list[float], p: float) -> float | None:
    """Linear-interpolated percentile. `p` is 0-100."""
    if not xs:
        return None
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * (p / 100.0)
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return s[int(k)]
    return s[lo] * (hi - k) + s[hi] * (k - lo)


def norm_cdf(z: float) -> float:
    """Standard normal CDF via erf — avoids a scipy dependency."""
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def norm_ppf(p: float) -> float:
    """Inverse standard normal CDF (Acklam's rational approximation).

    Accurate to ~1e-9 over (0,1), which is far beyond what price bands need.
    """
    if p <= 0.0:
        return float("-inf")
    if p >= 1.0:
        return float("inf")

    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]

    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
                ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def linreg(ys: list[float]) -> tuple[float, float, float]:
    """Least-squares fit of ys against t = 0..n-1.

    Returns (intercept, slope, r_squared).
    """
    n = len(ys)
    if n < 2:
        return (ys[0] if ys else 0.0), 0.0, 0.0
    xs = list(range(n))
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return my, 0.0, 0.0
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    slope = sxy / sxx
    intercept = my - slope * mx
    syy = sum((y - my) ** 2 for y in ys)
    r2 = (sxy ** 2) / (sxx * syy) if syy > 0 else 0.0
    return intercept, slope, r2


def clamp(v: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))
