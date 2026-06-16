"""Stock market data fetching.

Pluggable provider behind a stable interface so the rest of the app never cares
where the numbers came from. Two providers ship today:

  - "yfinance"  (default) — no API key, good for local dev. Uses Yahoo endpoints.
  - "finnhub"   — real REST API, needs FINNHUB_API_KEY. Free tier is plenty.

Select with the DATA_PROVIDER env var. Add a provider by writing a class with
`quotes()` and `history()` and registering it in _PROVIDERS.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from typing import Optional


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------
@dataclass
class Quote:
    symbol: str
    name: str
    price: float
    change: float          # absolute change vs previous close
    change_pct: float      # percent change vs previous close
    currency: str = "USD"
    pe: Optional[float] = None
    market_cap: Optional[float] = None  # in raw currency units

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class History:
    symbol: str
    dates: list[str]       # ISO dates
    closes: list[float]

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
class YFinanceProvider:
    """No-key provider for local dev. `pip install yfinance`."""

    name = "yfinance"

    def __init__(self) -> None:
        import yfinance  # imported lazily so finnhub-only installs don't need it
        self._yf = yfinance

    def quotes(self, symbols: list[str]) -> list[Quote]:
        out: list[Quote] = []
        tickers = self._yf.Tickers(" ".join(symbols))
        for sym in symbols:
            t = tickers.tickers.get(sym.upper()) or self._yf.Ticker(sym)
            info = getattr(t, "fast_info", {}) or {}
            try:
                meta = t.info  # heavier; wrapped because it can throw
            except Exception:
                meta = {}
            price = info.get("last_price") or meta.get("currentPrice") or 0.0
            prev = info.get("previous_close") or meta.get("previousClose") or price
            change = (price - prev) if price and prev else 0.0
            change_pct = (change / prev * 100) if prev else 0.0
            out.append(Quote(
                symbol=sym.upper(),
                name=meta.get("shortName") or meta.get("longName") or sym.upper(),
                price=round(float(price), 4),
                change=round(float(change), 4),
                change_pct=round(float(change_pct), 4),
                currency=meta.get("currency") or info.get("currency") or "USD",
                pe=_safe_float(meta.get("trailingPE")),
                market_cap=_safe_float(meta.get("marketCap")),
            ))
        return out

    def history(self, symbol: str, period: str = "6mo") -> History:
        hist = self._yf.Ticker(symbol).history(period=period)
        closes = hist["Close"].dropna()
        return History(
            symbol=symbol.upper(),
            dates=[d.strftime("%Y-%m-%d") for d in closes.index],
            closes=[round(float(c), 4) for c in closes.values],
        )


class FinnhubProvider:
    """Keyed REST provider. Set FINNHUB_API_KEY. `pip install requests`."""

    name = "finnhub"
    BASE = "https://finnhub.io/api/v1"

    def __init__(self) -> None:
        import requests
        self._requests = requests
        self.key = os.environ.get("FINNHUB_API_KEY")
        if not self.key:
            raise RuntimeError("FINNHUB_API_KEY not set but DATA_PROVIDER=finnhub")

    def _get(self, path: str, **params) -> dict:
        params["token"] = self.key
        r = self._requests.get(f"{self.BASE}{path}", params=params, timeout=15)
        r.raise_for_status()
        return r.json()

    def quotes(self, symbols: list[str]) -> list[Quote]:
        out: list[Quote] = []
        for sym in symbols:
            sym = sym.upper()
            q = self._get("/quote", symbol=sym)            # c=current, pc=prev close
            profile = self._get("/stock/profile2", symbol=sym)
            metric = self._get("/stock/metric", symbol=sym, metric="all").get("metric", {})
            price, prev = q.get("c", 0.0), q.get("pc", 0.0)
            change = price - prev
            change_pct = (change / prev * 100) if prev else 0.0
            out.append(Quote(
                symbol=sym,
                name=profile.get("name", sym),
                price=round(price, 4),
                change=round(change, 4),
                change_pct=round(change_pct, 4),
                currency=profile.get("currency", "USD"),
                pe=_safe_float(metric.get("peTTM")),
                # Finnhub marketCap is in millions of the listing currency
                market_cap=_safe_float(profile.get("marketCapitalization"),
                                       scale=1_000_000),
            ))
        return out

    def history(self, symbol: str, period: str = "6mo") -> History:
        days = _period_to_days(period)
        now = int(datetime.utcnow().timestamp())
        frm = int((datetime.utcnow() - timedelta(days=days)).timestamp())
        c = self._get("/stock/candle", symbol=symbol.upper(), resolution="D",
                      **{"from": frm, "to": now})
        if c.get("s") != "ok":
            return History(symbol=symbol.upper(), dates=[], closes=[])
        dates = [datetime.utcfromtimestamp(t).strftime("%Y-%m-%d") for t in c["t"]]
        return History(symbol=symbol.upper(),
                       dates=dates,
                       closes=[round(float(x), 4) for x in c["c"]])


_PROVIDERS = {
    "yfinance": YFinanceProvider,
    "finnhub": FinnhubProvider,
}

_provider_instance = None


def get_provider():
    """Return the configured provider (cached)."""
    global _provider_instance
    if _provider_instance is None:
        name = os.environ.get("DATA_PROVIDER", "yfinance").lower()
        cls = _PROVIDERS.get(name)
        if cls is None:
            raise ValueError(f"Unknown DATA_PROVIDER={name!r}. "
                             f"Options: {list(_PROVIDERS)}")
        _provider_instance = cls()
    return _provider_instance


# Convenience top-level functions ------------------------------------------------
def get_quotes(symbols: list[str]) -> list[Quote]:
    return get_provider().quotes([s.strip() for s in symbols if s.strip()])


def get_history(symbol: str, period: str = "6mo") -> History:
    return get_provider().history(symbol, period)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _safe_float(v, scale: float = 1.0) -> Optional[float]:
    try:
        if v is None or v == "":
            return None
        return float(v) * scale
    except (TypeError, ValueError):
        return None


def _period_to_days(period: str) -> int:
    table = {"1mo": 31, "3mo": 93, "6mo": 186, "1y": 366, "2y": 731, "5y": 1827}
    return table.get(period, 186)
