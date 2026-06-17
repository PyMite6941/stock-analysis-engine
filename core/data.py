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


@dataclass
class Fundamentals:
    """Detailed per-symbol stats for the focused-symbol info panel."""
    symbol: str
    name: str
    sector: Optional[str] = None
    industry: Optional[str] = None
    summary: Optional[str] = None          # business description
    currency: str = "USD"

    previous_close: Optional[float] = None
    open: Optional[float] = None
    bid: Optional[float] = None
    bid_size: Optional[int] = None
    ask: Optional[float] = None
    ask_size: Optional[int] = None
    day_low: Optional[float] = None
    day_high: Optional[float] = None
    week52_low: Optional[float] = None
    week52_high: Optional[float] = None
    volume: Optional[float] = None
    avg_volume: Optional[float] = None

    market_cap: Optional[float] = None
    beta: Optional[float] = None
    pe_ttm: Optional[float] = None
    eps_ttm: Optional[float] = None
    earnings_date: Optional[str] = None
    forward_dividend: Optional[float] = None
    dividend_yield_pct: Optional[float] = None
    ex_dividend_date: Optional[str] = None
    target_mean_price: Optional[float] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Candles:
    """Full OHLCV series for candlestick charting."""
    symbol: str
    dates: list[str]
    open: list[float]
    high: list[float]
    low: list[float]
    close: list[float]
    volume: list[float]

    def to_dict(self) -> dict:
        return asdict(self)

    def to_history(self) -> "History":
        return History(symbol=self.symbol, dates=self.dates, closes=self.close)


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
            # Index symbols (^GSPC, ^VIX, …) expose level via regularMarketPrice,
            # not currentPrice/last_price — so include those in the fallback chain.
            price = (info.get("last_price") or meta.get("currentPrice")
                     or meta.get("regularMarketPrice") or meta.get("previousClose") or 0.0)
            prev = (info.get("previous_close") or meta.get("regularMarketPreviousClose")
                    or meta.get("previousClose") or price)
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

    def fundamentals(self, symbol: str) -> Fundamentals:
        try:
            info = self._yf.Ticker(symbol).info
        except Exception:
            info = {}
        price = info.get("currentPrice") or info.get("previousClose")
        fwd_div = _safe_float(info.get("dividendRate"))
        # Compute yield from forward dividend / price (robust across yfinance versions)
        div_yield = round(fwd_div / price * 100, 2) if (fwd_div and price) else None
        return Fundamentals(
            symbol=symbol.upper(),
            name=info.get("shortName") or info.get("longName") or symbol.upper(),
            sector=info.get("sector"),
            industry=info.get("industry"),
            summary=info.get("longBusinessSummary"),
            currency=info.get("currency", "USD"),
            previous_close=_safe_float(info.get("previousClose")),
            open=_safe_float(info.get("open") or info.get("regularMarketOpen")),
            bid=_safe_float(info.get("bid")),
            bid_size=_safe_int(info.get("bidSize")),
            ask=_safe_float(info.get("ask")),
            ask_size=_safe_int(info.get("askSize")),
            day_low=_safe_float(info.get("dayLow")),
            day_high=_safe_float(info.get("dayHigh")),
            week52_low=_safe_float(info.get("fiftyTwoWeekLow")),
            week52_high=_safe_float(info.get("fiftyTwoWeekHigh")),
            volume=_safe_float(info.get("volume") or info.get("regularMarketVolume")),
            avg_volume=_safe_float(info.get("averageVolume")),
            market_cap=_safe_float(info.get("marketCap")),
            beta=_safe_float(info.get("beta")),
            pe_ttm=_safe_float(info.get("trailingPE")),
            eps_ttm=_safe_float(info.get("trailingEps")),
            earnings_date=_unix_to_date(info.get("earningsTimestamp")
                                        or info.get("earningsTimestampStart")),
            forward_dividend=fwd_div,
            dividend_yield_pct=div_yield,
            ex_dividend_date=_unix_to_date(info.get("exDividendDate")),
            target_mean_price=_safe_float(info.get("targetMeanPrice")),
        )

    # frontend interval -> (yfinance native interval, optional pandas resample rule).
    # Fine intraday intervals (2m/5m/15m/30m) give Yahoo-like notch density.
    # yfinance has no native 3h, so we pull hourly and aggregate to 3h.
    _YF_INTERVAL = {
        "1m": ("1m", None), "2m": ("2m", None), "5m": ("5m", None),
        "15m": ("15m", None), "30m": ("30m", None),
        "1h": ("60m", None), "3h": ("60m", "3h"),
        "1d": ("1d", None), "1wk": ("1wk", None), "1mo": ("1mo", None),
    }

    def insights(self, symbol: str) -> dict:
        """Beta, income/dividend detail, analyst recommendation split, and news."""
        t = self._yf.Ticker(symbol)
        try:
            info = t.info
        except Exception:
            info = {}

        price = info.get("currentPrice") or info.get("previousClose")
        rate = _safe_float(info.get("dividendRate"))
        payout = _safe_float(info.get("payoutRatio"))
        income = {
            "rate": rate,
            "dividend_yield_pct": round(rate / price * 100, 2) if (rate and price) else None,
            "payout_ratio_pct": round(payout * 100, 2) if payout is not None else None,
            "five_year_avg_yield_pct": _safe_float(info.get("fiveYearAvgDividendYield")),
            "ex_div_date": _unix_to_date(info.get("exDividendDate")),
        }

        rec = {}
        try:
            rdf = t.recommendations
            if rdf is not None and not rdf.empty and "strongBuy" in rdf.columns:
                row = rdf.iloc[0]
                rec = {k: int(row.get(j, 0) or 0) for k, j in [
                    ("strong_buy", "strongBuy"), ("buy", "buy"), ("hold", "hold"),
                    ("sell", "sell"), ("strong_sell", "strongSell")]}
        except Exception:
            pass

        news = []
        try:
            for n in (t.news or [])[:6]:
                c = n.get("content", n)
                prov = c.get("provider")
                title = c.get("title") or n.get("title")
                url = ((c.get("canonicalUrl") or {}).get("url")
                       or (c.get("clickThroughUrl") or {}).get("url") or n.get("link"))
                date = c.get("pubDate") or _unix_to_date(n.get("providerPublishTime"))
                if title:
                    news.append({
                        "title": title,
                        "publisher": (prov.get("displayName") if isinstance(prov, dict)
                                      else n.get("publisher")),
                        "url": url,
                        "date": (date[:10] if isinstance(date, str) else date),
                    })
        except Exception:
            pass

        return {"beta": _safe_float(info.get("beta")), "income": income,
                "recommendation": rec, "news": news}

    def statistics(self, symbol: str) -> dict:
        t = self._yf.Ticker(symbol)
        try:
            info = t.info
        except Exception:
            info = {}

        # Quarterly revenue vs. earnings (last 4 quarters, oldest -> newest).
        quarterly = []
        try:
            q = getattr(t, "quarterly_income_stmt", None)
            if q is None or q.empty:
                q = getattr(t, "quarterly_financials", None)
            if q is not None and not q.empty:
                rev = q.loc["Total Revenue"] if "Total Revenue" in q.index else None
                ni = q.loc["Net Income"] if "Net Income" in q.index else None
                for c in list(q.columns)[:4][::-1]:
                    quarterly.append({
                        "quarter": c.strftime("%b %Y") if hasattr(c, "strftime") else str(c),
                        "revenue": _safe_float(rev[c]) if rev is not None else None,
                        "earnings": _safe_float(ni[c]) if ni is not None else None,
                    })
        except Exception:
            pass

        pct = lambda v: round(v * 100, 2) if v is not None else None  # noqa: E731
        return {
            "symbol": symbol.upper(),
            "name": info.get("shortName") or info.get("longName") or symbol.upper(),
            "currency": info.get("currency", "USD"),
            "valuation": {
                "market_cap": _safe_float(info.get("marketCap")),
                "enterprise_value": _safe_float(info.get("enterpriseValue")),
                "trailing_pe": _safe_float(info.get("trailingPE")),
                "forward_pe": _safe_float(info.get("forwardPE")),
                "peg": _safe_float(info.get("trailingPegRatio") or info.get("pegRatio")),
                "price_to_sales": _safe_float(info.get("priceToSalesTrailing12Months")),
                "price_to_book": _safe_float(info.get("priceToBook")),
                "ev_to_revenue": _safe_float(info.get("enterpriseToRevenue")),
                "ev_to_ebitda": _safe_float(info.get("enterpriseToEbitda")),
            },
            "financials": {
                "profit_margin": pct(_safe_float(info.get("profitMargins"))),
                "roa": pct(_safe_float(info.get("returnOnAssets"))),
                "roe": pct(_safe_float(info.get("returnOnEquity"))),
                "revenue_ttm": _safe_float(info.get("totalRevenue")),
                "net_income": _safe_float(info.get("netIncomeToCommon")),
                "diluted_eps": _safe_float(info.get("trailingEps")),
                "total_cash": _safe_float(info.get("totalCash")),
                "debt_to_equity": _safe_float(info.get("debtToEquity")),
                "levered_fcf": _safe_float(info.get("freeCashflow")),
            },
            "analyst": {
                "current_price": _safe_float(info.get("currentPrice")),
                "target_low": _safe_float(info.get("targetLowPrice")),
                "target_mean": _safe_float(info.get("targetMeanPrice")),
                "target_high": _safe_float(info.get("targetHighPrice")),
                "recommendation_key": info.get("recommendationKey"),
                "recommendation_mean": _safe_float(info.get("recommendationMean")),
                "num_analysts": _safe_int(info.get("numberOfAnalystOpinions")),
            },
            "earnings": {
                "forward_eps": _safe_float(info.get("forwardEps")),
                "trailing_eps": _safe_float(info.get("trailingEps")),
                "quarterly": quarterly,
            },
        }

    def candles(self, symbol: str, period: str = "6mo",
                interval: str = "1d") -> Candles:
        native, resample = self._YF_INTERVAL.get(interval, ("1d", None))
        df = self._yf.Ticker(symbol).history(period=period, interval=native).dropna()
        if resample and not df.empty:
            df = df.resample(resample).agg({
                "Open": "first", "High": "max", "Low": "min",
                "Close": "last", "Volume": "sum",
            }).dropna()
        intraday = interval.endswith(("m", "h"))
        fmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
        return Candles(
            symbol=symbol.upper(),
            dates=[d.strftime(fmt) for d in df.index],
            open=[round(float(x), 4) for x in df["Open"].values],
            high=[round(float(x), 4) for x in df["High"].values],
            low=[round(float(x), 4) for x in df["Low"].values],
            close=[round(float(x), 4) for x in df["Close"].values],
            volume=[float(x) for x in df["Volume"].values],
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

    def fundamentals(self, symbol: str) -> Fundamentals:
        sym = symbol.upper()
        q = self._get("/quote", symbol=sym)
        profile = self._get("/stock/profile2", symbol=sym)
        m = self._get("/stock/metric", symbol=sym, metric="all").get("metric", {})
        fwd_div = _safe_float(m.get("dividendPerShareAnnual"))
        price = q.get("c")
        return Fundamentals(
            symbol=sym,
            name=profile.get("name", sym),
            sector=profile.get("finnhubIndustry"),
            industry=profile.get("finnhubIndustry"),
            summary=None,  # not available on the free Finnhub tier
            currency=profile.get("currency", "USD"),
            previous_close=_safe_float(q.get("pc")),
            open=_safe_float(q.get("o")),
            day_low=_safe_float(q.get("l")),
            day_high=_safe_float(q.get("h")),
            week52_low=_safe_float(m.get("52WeekLow")),
            week52_high=_safe_float(m.get("52WeekHigh")),
            avg_volume=_safe_float(m.get("10DayAverageTradingVolume"), scale=1_000_000),
            market_cap=_safe_float(profile.get("marketCapitalization"), scale=1_000_000),
            beta=_safe_float(m.get("beta")),
            pe_ttm=_safe_float(m.get("peTTM")),
            eps_ttm=_safe_float(m.get("epsTTM")),
            forward_dividend=fwd_div,
            dividend_yield_pct=round(fwd_div / price * 100, 2) if (fwd_div and price) else None,
            target_mean_price=None,
        )

    def statistics(self, symbol: str) -> dict:
        # Best-effort from the free Finnhub metric endpoint; quarterly series and
        # some fields aren't available on the free tier.
        sym = symbol.upper()
        m = self._get("/stock/metric", symbol=sym, metric="all").get("metric", {})
        profile = self._get("/stock/profile2", symbol=sym)
        return {
            "symbol": sym,
            "name": profile.get("name", sym),
            "currency": profile.get("currency", "USD"),
            "valuation": {
                "market_cap": _safe_float(profile.get("marketCapitalization"), scale=1_000_000),
                "enterprise_value": None,
                "trailing_pe": _safe_float(m.get("peTTM")),
                "forward_pe": _safe_float(m.get("forwardPE")),
                "peg": _safe_float(m.get("pegRatioTTM")),
                "price_to_sales": _safe_float(m.get("psTTM")),
                "price_to_book": _safe_float(m.get("pbAnnual")),
                "ev_to_revenue": _safe_float(m.get("currentEv/freeCashFlowTTM")),
                "ev_to_ebitda": _safe_float(m.get("currentEv/ebitdaTTM")),
            },
            "financials": {
                "profit_margin": _safe_float(m.get("netProfitMarginTTM")),
                "roa": _safe_float(m.get("roaTTM")),
                "roe": _safe_float(m.get("roeTTM")),
                "revenue_ttm": None,
                "net_income": None,
                "diluted_eps": _safe_float(m.get("epsTTM")),
                "total_cash": None,
                "debt_to_equity": _safe_float(m.get("totalDebt/totalEquityAnnual")),
                "levered_fcf": None,
            },
            "analyst": {
                "current_price": None, "target_low": None, "target_mean": None,
                "target_high": None, "recommendation_key": None,
                "recommendation_mean": None, "num_analysts": None,
            },
            "earnings": {
                "forward_eps": None,
                "trailing_eps": _safe_float(m.get("epsTTM")),
                "quarterly": [],
            },
        }

    def insights(self, symbol: str) -> dict:
        sym = symbol.upper()
        m = self._get("/stock/metric", symbol=sym, metric="all").get("metric", {})
        rec = {}
        try:
            data = self._get("/stock/recommendation", symbol=sym)
            if data:
                r = data[0]
                rec = {"strong_buy": r.get("strongBuy", 0), "buy": r.get("buy", 0),
                       "hold": r.get("hold", 0), "sell": r.get("sell", 0),
                       "strong_sell": r.get("strongSell", 0)}
        except Exception:
            pass
        return {
            "beta": _safe_float(m.get("beta")),
            "income": {
                "rate": _safe_float(m.get("dividendPerShareAnnual")),
                "dividend_yield_pct": _safe_float(m.get("dividendYieldIndicatedAnnual")),
                "payout_ratio_pct": _safe_float(m.get("payoutRatioTTM")),
                "five_year_avg_yield_pct": None, "ex_div_date": None,
            },
            "recommendation": rec, "news": [],
        }

    _RESOLUTION = {"1d": "D", "1wk": "W", "1mo": "M", "3h": "60", "1h": "60",
                   "30m": "30", "15m": "15", "5m": "5", "2m": "1", "1m": "1"}

    def candles(self, symbol: str, period: str = "6mo",
                interval: str = "1d") -> Candles:
        days = _period_to_days(period)
        resolution = self._RESOLUTION.get(interval, "D")
        now = int(datetime.utcnow().timestamp())
        frm = int((datetime.utcnow() - timedelta(days=days)).timestamp())
        c = self._get("/stock/candle", symbol=symbol.upper(), resolution=resolution,
                      **{"from": frm, "to": now})
        if c.get("s") != "ok":
            return Candles(symbol.upper(), [], [], [], [], [], [])
        intraday = interval.endswith(("m", "h"))
        fmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
        return Candles(
            symbol=symbol.upper(),
            dates=[datetime.utcfromtimestamp(t).strftime(fmt) for t in c["t"]],
            open=[round(float(x), 4) for x in c["o"]],
            high=[round(float(x), 4) for x in c["h"]],
            low=[round(float(x), 4) for x in c["l"]],
            close=[round(float(x), 4) for x in c["c"]],
            volume=[float(x) for x in c["v"]],
        )


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


def get_candles(symbol: str, period: str = "6mo", interval: str = "1d") -> Candles:
    return get_provider().candles(symbol, period, interval)


def get_fundamentals(symbol: str) -> Fundamentals:
    return get_provider().fundamentals(symbol)


def get_statistics(symbol: str) -> dict:
    return get_provider().statistics(symbol)


def get_insights(symbol: str) -> dict:
    return get_provider().insights(symbol)


def get_history(symbol: str, period: str = "6mo") -> History:
    # Close-only view, derived from the full candle fetch.
    return get_provider().candles(symbol, period).to_history()


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


def _safe_int(v) -> Optional[int]:
    try:
        if v is None or v == "":
            return None
        return int(v)
    except (TypeError, ValueError):
        return None


def _unix_to_date(ts) -> Optional[str]:
    """Convert a UNIX timestamp (seconds) to 'YYYY-MM-DD', tolerating junk."""
    try:
        if not ts:
            return None
        return datetime.utcfromtimestamp(int(ts)).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError):
        return None


def _period_to_days(period: str) -> int:
    table = {"1d": 1, "5d": 5, "1mo": 31, "3mo": 93, "6mo": 186,
             "1y": 366, "2y": 731, "5y": 1827}
    return table.get(period, 186)
