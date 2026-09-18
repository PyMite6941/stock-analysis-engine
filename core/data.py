"""Stock market data fetching.

Pluggable provider behind a stable interface so the rest of the app never cares
where the numbers came from. Three providers ship today:

  - "yfinance" — no API key, good for local dev. Uses Yahoo endpoints.
  - "finnhub"  — real REST API, needs FINNHUB_API_KEY. Free tier is plenty.
  - "hybrid"   — real-time quotes from Finnhub + everything else from yfinance.

Selection is automatic: set FINNHUB_API_KEY and you get "hybrid", otherwise
"yfinance". DATA_PROVIDER overrides that when you want something specific. The
auto-upgrade exists because Yahoo throttles datacentre IPs, so a cloud deploy
that has the key but forgot the switch would silently run the weaker provider.

Add a provider by writing a class with `quotes()` and `candles()` and
registering it in _PROVIDERS.
"""

from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger("stock-engine.data")

# Yahoo throttles datacentre IPs and signals it with an empty frame, not an
# error. Two retries with a short backoff clears most of it without making a
# genuinely dead ticker slow to report.
_YF_RETRIES = 3
_YF_BACKOFF = 0.4


# ---------------------------------------------------------------------------
# Tiny in-process TTL cache.
# A single analysis-page load hits the slow yfinance `.info` scrape ~4x per
# symbol (quotes + fundamentals + statistics + insights). Caching it collapses
# those to one fetch, and keeps repeat views fast on a warm serverless instance.
# ---------------------------------------------------------------------------
_CACHE: dict[str, tuple[float, object]] = {}


def _cache_get(key: str, ttl: float):
    entry = _CACHE.get(key)
    if entry and (time.time() - entry[0]) < ttl:
        return entry[1]
    return None


def _cache_put(key: str, value):
    _CACHE[key] = (time.time(), value)
    return value


class SymbolNotFound(LookupError):
    """The ticker doesn't exist at the provider.

    Distinct from a network/provider failure on purpose: a typo'd ticker is a
    user error with an obvious fix, and surfacing it as a generic request
    failure sends people hunting for a connection problem that isn't there. The
    API turns this into a 404 with a plain-English message.
    """

    def __init__(self, symbol: str):
        self.symbol = (symbol or "").upper()
        super().__init__(f"Stock/ETF not found: {self.symbol}")


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
    # True when the provider has no such ticker. Carried on the quote rather
    # than raised, so one typo in a watchlist doesn't blank the other symbols.
    not_found: bool = False

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
# Keyless fallback: Yahoo's public chart endpoint
# ---------------------------------------------------------------------------
# yfinance is a scraper. It performs a cookie/crumb handshake against Yahoo and
# that handshake is the part that breaks — on throttled cloud IPs, and whenever
# Yahoo changes it. The v8 chart endpoint underneath needs no cookie, no crumb,
# no API key and no account, so it keeps working when the wrapper does not.
#
# This is deliberately a SECOND PATH rather than a replacement: yfinance stays
# primary because it also supplies fundamentals, statistics and insights that
# this endpoint has no equivalent for. The fallback covers prices only, which is
# the part everything else is built on.
_YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

# Yahoo serves a browser-ish UA far more reliably than a bare library default.
_YAHOO_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/131.0.0.0 Safari/537.36"),
    "Accept": "application/json,text/plain,*/*",
}

# The app's interval names map onto Yahoo's directly except for 1h/3h.
_YAHOO_INTERVAL = {
    "1m": "1m", "2m": "2m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "60m", "3h": "60m", "1d": "1d", "1wk": "1wk", "1mo": "1mo",
}


def yahoo_chart(symbol: str, period: str = "6mo", interval: str = "1d") -> Candles:
    """Fetch OHLCV straight from Yahoo's chart API. No key, no auth.

    Returns empty Candles on any failure — callers already treat an empty series
    as "no data", and a fallback that raises would defeat the point.
    """
    import requests

    sym = symbol.upper()
    native = _YAHOO_INTERVAL.get(interval, "1d")
    intraday = interval.endswith(("m", "h"))
    try:
        r = requests.get(
            _YAHOO_CHART.format(symbol=sym),
            params={"range": period, "interval": native,
                    "includePrePost": "true" if intraday else "false"},
            headers=_YAHOO_HEADERS, timeout=20)
        r.raise_for_status()
        result = (r.json().get("chart") or {}).get("result") or []
        if not result:
            return Candles(sym, [], [], [], [], [], [])
        block = result[0]
        stamps = block.get("timestamp") or []
        quote = ((block.get("indicators") or {}).get("quote") or [{}])[0]
    except Exception as e:  # noqa: BLE001 — a failed fallback is just no data
        logger.warning("Yahoo chart fallback failed for %s: %s", sym, e)
        return Candles(sym, [], [], [], [], [], [])

    if not stamps:
        return Candles(sym, [], [], [], [], [], [])

    # Intraday timestamps are epoch UTC, but the rest of the app encodes
    # exchange wall-clock as if it were UTC (the chart axis formats with
    # timeZone:'UTC' to match). Shift by the exchange offset so the two paths
    # produce identical strings for the same bar.
    offset = (block.get("meta") or {}).get("gmtoffset") or 0
    fmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"

    dates, o, h, l, c, v = [], [], [], [], [], []
    for i, ts in enumerate(stamps):
        row = [(quote.get(k) or [None] * len(stamps))[i]
               for k in ("open", "high", "low", "close", "volume")]
        # Yahoo pads gaps with nulls; drop those bars rather than interpolating.
        if any(x is None for x in row[:4]):
            continue
        # fromtimestamp(..., utc) then drop the tzinfo: utcfromtimestamp is
        # deprecated, and we want a naive stamp carrying exchange wall-clock.
        dates.append(datetime.fromtimestamp(
            ts + (offset if intraday else 0), timezone.utc
        ).replace(tzinfo=None).strftime(fmt))
        o.append(round(float(row[0]), 4))
        h.append(round(float(row[1]), 4))
        l.append(round(float(row[2]), 4))
        c.append(round(float(row[3]), 4))
        v.append(float(row[4] or 0))

    candles = Candles(sym, dates, o, h, l, c, v)
    # 3h is not a native Yahoo interval — resample from 60m the same way the
    # yfinance path does, so both sources agree bar for bar.
    if interval == "3h":
        candles = _resample_3h(candles)
    return candles


def _resample_3h(c: Candles) -> Candles:
    """Aggregate 60m bars into 3h groups (open-first, high-max, low-min,
    close-last, volume-sum)."""
    if not c.dates:
        return c
    dates, o, h, l, cl, v = [], [], [], [], [], []
    for i in range(0, len(c.dates), 3):
        chunk = slice(i, i + 3)
        dates.append(c.dates[i])
        o.append(c.open[chunk][0])
        h.append(max(c.high[chunk]))
        l.append(min(c.low[chunk]))
        cl.append(c.close[chunk][-1])
        v.append(sum(c.volume[chunk]))
    return Candles(c.symbol, dates, o, h, l, cl, v)


def yahoo_quote(symbol: str) -> Optional[Quote]:
    """Best-effort quote from the same keyless endpoint.

    Carries no P/E or market cap — the chart API doesn't expose them — so those
    stay None. A quote with a real price and no ratios beats no quote at all.
    """
    c_meta_symbol = symbol.upper()
    try:
        import requests
        r = requests.get(
            _YAHOO_CHART.format(symbol=c_meta_symbol),
            params={"range": "5d", "interval": "1d"},
            headers=_YAHOO_HEADERS, timeout=20)
        r.raise_for_status()
        result = (r.json().get("chart") or {}).get("result") or []
        if not result:
            return None
        meta = result[0].get("meta") or {}
        closes = [x for x in
                  (((result[0].get("indicators") or {}).get("quote") or [{}])[0]
                   .get("close") or []) if x is not None]
    except Exception as e:  # noqa: BLE001
        logger.warning("Yahoo quote fallback failed for %s: %s", c_meta_symbol, e)
        return None

    price = meta.get("regularMarketPrice") or (closes[-1] if closes else None)
    if not price:
        return None
    # Order matters. `chartPreviousClose` is the close BEFORE the requested
    # range — over a 5-day window that's last week, and using it reported a
    # 5-day move as if it were today's change (+5.4% when the stock was down
    # 0.5%). The prior daily bar is the real previous close, so prefer it and
    # keep chartPreviousClose only as a last resort for a 1-bar response.
    prev = (meta.get("previousClose")
            or (closes[-2] if len(closes) > 1 else None)
            or meta.get("chartPreviousClose")
            or price)
    change = price - prev if prev else 0.0
    return Quote(
        symbol=c_meta_symbol,
        name=meta.get("longName") or meta.get("shortName") or c_meta_symbol,
        price=round(float(price), 4),
        change=round(float(change), 4),
        change_pct=round(change / prev * 100, 4) if prev else 0.0,
        currency=meta.get("currency") or "USD",
    )


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
class YFinanceProvider:
    """No-key provider for local dev. `pip install yfinance`."""

    name = "yfinance"

    def __init__(self) -> None:
        import yfinance  # imported lazily so finnhub-only installs don't need it
        self._yf = yfinance

    def _info(self, symbol: str) -> dict:
        """Cached `Ticker.info` — the slow scrape shared across endpoints (5 min)."""
        key = f"info:{symbol.upper()}"
        cached = _cache_get(key, 300)
        if cached is not None:
            return cached
        try:
            info = self._yf.Ticker(symbol).info
        except Exception:
            info = {}
        return _cache_put(key, info)

    def _quote_one(self, sym: str) -> Quote:
        sym = sym.upper()
        fast = getattr(self._yf.Ticker(sym), "fast_info", {}) or {}
        meta = self._info(sym)
        # Index symbols (^GSPC, ^VIX, …) expose level via regularMarketPrice,
        # not currentPrice/last_price — so include those in the fallback chain.
        price = (fast.get("last_price") or meta.get("currentPrice")
                 or meta.get("regularMarketPrice") or meta.get("previousClose") or 0.0)
        prev = (fast.get("previous_close") or meta.get("regularMarketPreviousClose")
                or meta.get("previousClose") or price)
        # Yahoo answers an unknown ticker with a near-empty info dict and no
        # price at all. That looks identical to the scrape being throttled, so
        # before calling it a typo, ask the keyless endpoint — otherwise a real
        # ticker gets reported to the user as "Stock/ETF not found" whenever
        # yfinance is having a bad minute.
        if not price and not _has_identity(meta):
            fallback = yahoo_quote(sym)
            if fallback is not None:
                logger.info("Yahoo quote fallback served %s", sym)
                return fallback
            # Both sources have nothing: now it really is an unknown ticker.
            return Quote(symbol=sym, name=sym, price=0.0, change=0.0,
                         change_pct=0.0, not_found=True)
        change = (price - prev) if price and prev else 0.0
        change_pct = (change / prev * 100) if prev else 0.0
        return Quote(
            symbol=sym,
            name=meta.get("shortName") or meta.get("longName") or sym,
            price=round(float(price), 4),
            change=round(float(change), 4),
            change_pct=round(float(change_pct), 4),
            currency=meta.get("currency") or fast.get("currency") or "USD",
            pe=_safe_float(meta.get("trailingPE")),
            market_cap=_safe_float(meta.get("marketCap")),
        )

    def quotes(self, symbols: list[str]) -> list[Quote]:
        # Fetch in parallel — each symbol's .info is an independent network call.
        with ThreadPoolExecutor(max_workers=min(8, max(1, len(symbols)))) as ex:
            return list(ex.map(self._quote_one, symbols))

    def fundamentals(self, symbol: str) -> Fundamentals:
        info = self._info(symbol)
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
        info = self._info(symbol)

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
        info = self._info(symbol)

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

    def holdings(self, symbol: str) -> dict:
        """What an ETF / index fund actually owns.

        Buying SPY means buying ~500 companies, and the concentration inside the
        wrapper is the thing people miss — a "diversified" S&P fund is a third
        technology. So we return top holdings, sector weights, and asset mix.

        Returns {"is_fund": False} for ordinary stocks so callers can branch
        without a second lookup.
        """
        sym = symbol.upper()
        key = f"holdings:{sym}"
        cached = _cache_get(key, 3600)  # fund composition changes slowly
        if cached is not None:
            return cached

        info = self._info(sym)
        quote_type = (info.get("quoteType") or "").upper()
        out = {
            "symbol": sym,
            "name": info.get("shortName") or info.get("longName") or sym,
            "quote_type": quote_type or None,
            "is_fund": quote_type in ("ETF", "MUTUALFUND", "INDEX"),
            "holdings": [],
            "sectors": [],
            "asset_classes": {},
        }
        if not out["is_fund"]:
            return _cache_put(key, out)

        try:
            fd = self._yf.Ticker(sym).funds_data
        except Exception:
            return _cache_put(key, out)

        try:
            top = fd.top_holdings
            if top is not None and not top.empty:
                # Index is the ticker; the percent column arrives as a fraction.
                col = "Holding Percent"
                out["holdings"] = [
                    {"symbol": str(idx),
                     "name": str(row.get("Name", idx)),
                     "weight_pct": round(float(row[col]) * 100, 3)
                     if col in row and row[col] is not None else None}
                    for idx, row in top.iterrows()
                ]
                out["top_n_weight_pct"] = round(
                    sum(h["weight_pct"] or 0 for h in out["holdings"]), 2)
        except Exception:
            pass

        try:
            sectors = fd.sector_weightings or {}
            out["sectors"] = sorted(
                ({"sector": k.replace("_", " ").title(),
                  "weight_pct": round(float(v) * 100, 2)}
                 for k, v in sectors.items() if v is not None),
                key=lambda s: -s["weight_pct"])
        except Exception:
            pass

        for attr, dest in (("asset_classes", "asset_classes"),
                           ("fund_overview", "overview"),
                           ("fund_operations", None)):
            try:
                val = getattr(fd, attr, None)
                if attr == "asset_classes" and val:
                    out["asset_classes"] = {
                        k: round(float(v) * 100, 2) for k, v in val.items()
                        if v is not None}
                elif dest and val:
                    out[dest] = {k: v for k, v in dict(val).items() if v is not None}
            except Exception:
                continue

        try:
            out["description"] = fd.description or None
        except Exception:
            out["description"] = None

        # Expense ratio and ytdReturn live on .info, not funds_data, and Yahoo
        # already reports both as percents (SPY is 0.0945, i.e. 0.0945%) — do
        # NOT multiply by 100 here.
        out["expense_ratio_pct"] = _safe_float(
            info.get("netExpenseRatio") or info.get("annualReportExpenseRatio"))
        out["total_assets"] = _safe_float(info.get("totalAssets"))
        out["ytd_return_pct"] = _safe_float(info.get("ytdReturn"))
        return _cache_put(key, out)

    def candles(self, symbol: str, period: str = "6mo",
                interval: str = "1d") -> Candles:
        key = f"candles:{symbol.upper()}:{period}:{interval}"
        cached = _cache_get(key, 15)  # short cache so intraday stays fresh
        if cached is not None:
            return cached
        native, resample = self._YF_INTERVAL.get(interval, ("1d", None))
        intraday_iv = interval.endswith(("m", "h"))
        # prepost=True includes pre-market / after-hours bars so the latest data
        # isn't stuck at the 4pm close when the regular session is over.
        #
        # Retried because Yahoo throttles datacentre IPs and answers with an
        # EMPTY frame rather than an error — indistinguishable from a delisted
        # ticker at this layer, and it used to surface to the user as
        # "Stock/ETF not found" for a perfectly real symbol. The hybrid provider
        # only routes *quotes* through Finnhub, so history has no other path.
        df = None
        for attempt in range(_YF_RETRIES):
            try:
                df = self._yf.Ticker(symbol).history(
                    period=period, interval=native, prepost=intraday_iv).dropna()
                if not df.empty:
                    break
            except Exception as e:  # noqa: BLE001 — transient network/parse errors
                logger.warning("yfinance history failed for %s (attempt %d/%d): %s",
                               symbol, attempt + 1, _YF_RETRIES, e)
                df = None
            if attempt < _YF_RETRIES - 1:
                time.sleep(_YF_BACKOFF * (2 ** attempt))

        if df is None or df.empty:
            logger.warning("yfinance returned no bars for %s (%s/%s) after %d "
                           "attempts; trying the keyless Yahoo chart endpoint",
                           symbol, period, interval, _YF_RETRIES)
            # Second path: the scraper's cookie/crumb handshake is the fragile
            # part, and the raw chart endpoint doesn't use it.
            fallback = yahoo_chart(symbol, period, interval)
            if fallback.close:
                logger.info("Yahoo chart fallback served %d bars for %s",
                            len(fallback.close), symbol)
                return _cache_put(key, fallback)
            # Don't cache a failure — the next request should try again rather
            # than serve an empty chart for the full cache TTL.
            return Candles(symbol.upper(), [], [], [], [], [], [])
        if resample and not df.empty:
            df = df.resample(resample).agg({
                "Open": "first", "High": "max", "Low": "min",
                "Close": "last", "Volume": "sum",
            }).dropna()
        intraday = interval.endswith(("m", "h"))
        fmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
        result = Candles(
            symbol=symbol.upper(),
            dates=[d.strftime(fmt) for d in df.index],
            open=[round(float(x), 4) for x in df["Open"].values],
            high=[round(float(x), 4) for x in df["High"].values],
            low=[round(float(x), 4) for x in df["Low"].values],
            close=[round(float(x), 4) for x in df["Close"].values],
            volume=[float(x) for x in df["Volume"].values],
        )
        return _cache_put(key, result)


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
            # Finnhub answers an unknown ticker with zeroed quote + empty profile.
            if not q.get("c") and not profile.get("name"):
                out.append(Quote(symbol=sym, name=sym, price=0.0, change=0.0,
                                 change_pct=0.0, not_found=True))
                continue
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

    def holdings(self, symbol: str) -> dict:
        """Finnhub gates ETF holdings behind a paid plan, so borrow yfinance.

        Fund composition is static enough that mixing providers for this one
        field costs nothing in consistency, and the alternative is an empty
        panel on every index fund.
        """
        try:
            return YFinanceProvider().holdings(symbol)
        except Exception:
            return {"symbol": symbol.upper(), "is_fund": False, "holdings": [],
                    "sectors": [], "asset_classes": {},
                    "unavailable": "ETF holdings need the yfinance provider."}

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


class HybridProvider(YFinanceProvider):
    """Free real-time quotes from Finnhub's free tier + everything else (history,
    fundamentals, statistics, insights) from yfinance.

    Finnhub's free plan returns *real-time* US-stock last prices (no 15-min
    delay), and its API is reliable from cloud IPs where yfinance sometimes gets
    throttled. Set DATA_PROVIDER=hybrid and a free FINNHUB_API_KEY to enable.
    Index symbols (^GSPC, …) and any Finnhub miss fall back to yfinance.
    """

    name = "hybrid"

    def __init__(self) -> None:
        super().__init__()
        self._fh = FinnhubProvider()  # raises if FINNHUB_API_KEY missing

    def _quote_one(self, sym: str) -> Quote:
        sym = sym.upper()
        try:
            q = self._fh._get("/quote", symbol=sym)
            price, prev = q.get("c") or 0.0, q.get("pc") or 0.0
            if not price:  # Finnhub has no data (e.g. an index) — fall back
                return super()._quote_one(sym)
            meta = self._info(sym)  # name / PE / market cap from yfinance (cached)
            change = price - prev
            return Quote(
                symbol=sym,
                name=meta.get("shortName") or meta.get("longName") or sym,
                price=round(price, 4),
                change=round(change, 4),
                change_pct=round(change / prev * 100, 4) if prev else 0.0,
                currency=meta.get("currency", "USD"),
                pe=_safe_float(meta.get("trailingPE")),
                market_cap=_safe_float(meta.get("marketCap")),
            )
        except Exception:
            return super()._quote_one(sym)


_PROVIDERS = {
    "yfinance": YFinanceProvider,
    "finnhub": FinnhubProvider,
    "hybrid": HybridProvider,
}

_provider_instance = None


def choose_provider_name() -> str:
    """Pick a provider from the environment.

    An explicit DATA_PROVIDER always wins. Otherwise we upgrade automatically:
    a FINNHUB_API_KEY means hybrid is available, and hybrid is strictly better
    than bare yfinance in the cloud (Yahoo throttles datacentre IPs, Finnhub
    doesn't). Auto-selecting means deploying only needs the KEY, not a second
    variable set to the right string — one fewer thing to get wrong, and no
    silent fallback to the weaker provider because someone set the key and
    forgot the switch.
    """
    explicit = os.environ.get("DATA_PROVIDER", "").strip().lower()
    if explicit:
        return explicit
    return "hybrid" if os.environ.get("FINNHUB_API_KEY") else "yfinance"


def get_provider():
    """Return the configured provider (cached).

    Degrades rather than dies: a provider that can't be constructed (usually a
    missing key) falls back to yfinance. A misconfigured env var should make the
    data less good, not take the whole API down with a 500 on every route.
    """
    global _provider_instance
    if _provider_instance is not None:
        return _provider_instance

    name = choose_provider_name()
    cls = _PROVIDERS.get(name)
    if cls is None:
        logger.warning("Unknown DATA_PROVIDER=%r; falling back to yfinance. "
                       "Options: %s", name, list(_PROVIDERS))
        cls, name = YFinanceProvider, "yfinance"

    try:
        _provider_instance = cls()
    except Exception as e:  # noqa: BLE001 — missing key, missing dep, etc.
        if cls is YFinanceProvider:
            raise
        logger.warning("Data provider %r unavailable (%s); falling back to "
                       "yfinance.", name, e)
        _provider_instance = YFinanceProvider()
    return _provider_instance


def reset_provider() -> None:
    """Drop the cached provider so a changed environment takes effect.

    Only used by tests; the serverless instance reads the env once at boot.
    """
    global _provider_instance
    _provider_instance = None


# Convenience top-level functions ------------------------------------------------
def get_quotes(symbols: list[str]) -> list[Quote]:
    return get_provider().quotes([s.strip() for s in symbols if s.strip()])


def require_symbol(symbol: str) -> Quote:
    """Resolve a ticker or raise SymbolNotFound.

    Single-symbol endpoints call this first so a typo fails fast with a clear
    message instead of rendering a page full of dashes.
    """
    sym = (symbol or "").strip()
    if not sym:
        raise SymbolNotFound(sym)
    quotes = get_quotes([sym])
    if not quotes or quotes[0].not_found:
        raise SymbolNotFound(sym)
    return quotes[0]


def get_candles(symbol: str, period: str = "6mo", interval: str = "1d") -> Candles:
    c = get_provider().candles(symbol, period, interval)
    # Empty series is ambiguous — a dead ticker and a period with no bars look
    # identical here, so ask the quote endpoint which one it is.
    if not c.close:
        require_symbol(symbol)
    return c


def get_fundamentals(symbol: str) -> Fundamentals:
    return get_provider().fundamentals(symbol)


def get_statistics(symbol: str) -> dict:
    return get_provider().statistics(symbol)


def get_insights(symbol: str) -> dict:
    return get_provider().insights(symbol)


def get_holdings(symbol: str) -> dict:
    """ETF / index-fund composition. {"is_fund": False} for ordinary stocks."""
    return get_provider().holdings(symbol)


def get_quote_type(symbol: str) -> Optional[str]:
    """The provider's quoteType (EQUITY / ETF / MUTUALFUND / CRYPTOCURRENCY...).

    Read from the cached .info, so asking for it costs nothing once a symbol has
    been looked at. Returns None when the provider can't say.
    """
    provider = get_provider()
    info = getattr(provider, "_info", None)
    if info is None:
        return None
    try:
        return (info(symbol) or {}).get("quoteType")
    except Exception:  # noqa: BLE001 — classification falls back to the symbol
        return None


def describe_asset(symbol: str) -> dict:
    """Asset class + capability flags, for callers that need to adapt."""
    from . import assets
    return assets.describe(symbol, get_quote_type(symbol))


def get_history(symbol: str, period: str = "6mo") -> History:
    # Close-only view, derived from the full candle fetch.
    return get_provider().candles(symbol, period).to_history()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
# Any one of these on a .info dict means the provider actually knows the ticker.
_IDENTITY_KEYS = ("shortName", "longName", "symbol", "quoteType", "exchange",
                  "regularMarketPrice", "previousClose", "currency")


def _has_identity(info: dict) -> bool:
    return bool(info) and any(info.get(k) for k in _IDENTITY_KEYS)


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
