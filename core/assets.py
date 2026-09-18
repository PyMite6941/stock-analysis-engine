"""What kind of thing is this ticker, and what does that change?

The app was written for US equities, where a handful of assumptions are safe:
there is a 09:30-16:00 session, there is intraday data, there is a P/E, there is
volume. None of those hold across every asset the provider will happily quote.

  CRYPTO        trades 24/7. There is no open, no close and no pre-market, so
                slicing the day at 09:30 New York produces a "session" that is
                an arbitrary six hours of a continuous market — and the pivots,
                VWAP and opening range computed from it are meaningless.
  MUTUAL FUND   priced once a day at NAV. No intraday bars at all, no volume,
                no bid/ask, no VWAP. Day-trading concepts do not merely give
                poor answers here, they have no referent.
  ETF / INDEX   behave like equities for pricing, but an ETF also has holdings.

Classification drives capability flags rather than scattered `if symbol ==` checks,
so a panel asks "does this asset have intraday data" instead of guessing.
Pure functions, no I/O.
"""

from __future__ import annotations

EQUITY = "equity"
ETF = "etf"
MUTUAL_FUND = "mutual_fund"
CRYPTO = "crypto"
INDEX = "index"
CURRENCY = "currency"
UNKNOWN = "unknown"

# What the provider's quoteType maps to.
_QUOTE_TYPE = {
    "EQUITY": EQUITY,
    "ETF": ETF,
    "MUTUALFUND": MUTUAL_FUND,
    "CRYPTOCURRENCY": CRYPTO,
    "INDEX": INDEX,
    "CURRENCY": CURRENCY,
    "FUTURE": EQUITY,
}

# Used only when there's no quoteType to go on (a cold cache, a provider miss).
# Deliberately conservative — a wrong guess is worse than "unknown".
_CRYPTO_SUFFIXES = ("-USD", "-USDT", "-EUR", "-GBP", "-BTC", "-ETH")
_KNOWN_CRYPTO = {
    "BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "MATIC",
    "LTC", "BCH", "XLM", "UNI", "ATOM", "ETC", "NEAR", "APT", "ARB", "OP",
}


def classify(symbol: str, quote_type: str | None = None) -> str:
    """Asset class from the provider's quoteType, falling back to the symbol."""
    if quote_type:
        mapped = _QUOTE_TYPE.get(str(quote_type).strip().upper())
        if mapped:
            return mapped

    sym = (symbol or "").strip().upper()
    if not sym:
        return UNKNOWN
    if sym.startswith("^"):
        return INDEX
    if sym.endswith("=X"):
        return CURRENCY
    if any(sym.endswith(s) for s in _CRYPTO_SUFFIXES):
        base = sym.rsplit("-", 1)[0]
        # X-USD is also how some currencies are written, so require a base that
        # actually looks like a crypto ticker.
        if base in _KNOWN_CRYPTO or len(base) <= 5:
            return CRYPTO
    # A five-letter ticker ending in X is the US mutual-fund convention
    # (VFIAX, FXAIX). Not reliable enough to use when quoteType is available.
    if len(sym) == 5 and sym.endswith("X") and sym.isalpha():
        return MUTUAL_FUND
    return UNKNOWN


# Per-class capabilities. A panel asks these rather than testing the class name,
# so adding an asset class later doesn't mean hunting for every branch.
_CAPABILITIES = {
    EQUITY: {
        "intraday": True, "session_hours": True, "volume": True,
        "pe": True, "market_cap": True, "dividends": True, "holdings": False,
        "day_tradeable": True, "earnings": True, "bid_ask": True,
        "label": "Stock", "trades": "weekdays 09:30-16:00 ET",
    },
    ETF: {
        "intraday": True, "session_hours": True, "volume": True,
        "pe": True, "market_cap": False, "dividends": True, "holdings": True,
        "day_tradeable": True, "earnings": False, "bid_ask": True,
        "label": "ETF", "trades": "weekdays 09:30-16:00 ET",
    },
    MUTUAL_FUND: {
        # The important row. Everything intraday is absent by construction.
        "intraday": False, "session_hours": False, "volume": False,
        "pe": True, "market_cap": False, "dividends": True, "holdings": True,
        "day_tradeable": False, "earnings": False, "bid_ask": False,
        "label": "Mutual fund", "trades": "priced once daily at NAV",
    },
    CRYPTO: {
        "intraday": True, "session_hours": False, "volume": True,
        "pe": False, "market_cap": True, "dividends": False, "holdings": False,
        "day_tradeable": True, "earnings": False, "bid_ask": False,
        "label": "Crypto", "trades": "24/7",
    },
    INDEX: {
        "intraday": True, "session_hours": True, "volume": False,
        "pe": False, "market_cap": False, "dividends": False, "holdings": False,
        "day_tradeable": False, "earnings": False, "bid_ask": False,
        "label": "Index", "trades": "weekdays 09:30-16:00 ET",
    },
    CURRENCY: {
        "intraday": True, "session_hours": False, "volume": False,
        "pe": False, "market_cap": False, "dividends": False, "holdings": False,
        "day_tradeable": True, "earnings": False, "bid_ask": True,
        "label": "Currency", "trades": "24/5",
    },
    UNKNOWN: {
        "intraday": True, "session_hours": True, "volume": True,
        "pe": True, "market_cap": True, "dividends": True, "holdings": False,
        "day_tradeable": True, "earnings": True, "bid_ask": True,
        "label": "Security", "trades": "unknown",
    },
}


def capabilities(asset_class: str) -> dict:
    return dict(_CAPABILITIES.get(asset_class, _CAPABILITIES[UNKNOWN]))


def describe(symbol: str, quote_type: str | None = None) -> dict:
    """Everything the UI needs to adapt to this asset in one object."""
    cls = classify(symbol, quote_type)
    caps = capabilities(cls)
    return {
        "symbol": (symbol or "").upper(),
        "asset_class": cls,
        "quote_type": quote_type,
        **caps,
        "continuous": cls in (CRYPTO, CURRENCY),
    }


def is_continuous(asset_class: str) -> bool:
    """True for markets with no daily open or close — the 24/7 ones.

    `daytrade` uses this to decide whether "the session" means a US trading day
    or a UTC calendar day.
    """
    return asset_class in (CRYPTO, CURRENCY)


# Timeframes worth offering per class. A mutual fund has no intraday history,
# so offering 1D/5D produces an empty chart and a confused user.
_TIMEFRAMES = {
    MUTUAL_FUND: ["1mo", "3mo", "6mo", "1y", "2y", "5y"],
}
_DEFAULT_TIMEFRAMES = ["1D", "5D", "1mo", "3mo", "6mo", "1y", "2y", "5y"]


def timeframes(asset_class: str) -> list[str]:
    return list(_TIMEFRAMES.get(asset_class, _DEFAULT_TIMEFRAMES))
