"""Asset classification and the behaviour it drives.

The app was written for US equities. Crypto trades 24/7 and mutual funds are
priced once a day at NAV, so the equity assumptions — a 09:30-16:00 session,
intraday bars, a P/E, share volume — are wrong for both.
"""

import pytest

from core import assets, daytrade


# --- classification --------------------------------------------------------
@pytest.mark.parametrize("symbol,quote_type,expected", [
    ("AAPL", "EQUITY", assets.EQUITY),
    ("SPY", "ETF", assets.ETF),
    ("VFIAX", "MUTUALFUND", assets.MUTUAL_FUND),
    ("BTC-USD", "CRYPTOCURRENCY", assets.CRYPTO),
    ("^GSPC", "INDEX", assets.INDEX),
    ("EURUSD=X", "CURRENCY", assets.CURRENCY),
])
def test_quote_type_drives_classification(symbol, quote_type, expected):
    assert assets.classify(symbol, quote_type) == expected


@pytest.mark.parametrize("symbol,expected", [
    ("BTC-USD", assets.CRYPTO),
    ("ETH-USD", assets.CRYPTO),
    ("SOL-USD", assets.CRYPTO),
    ("^GSPC", assets.INDEX),
    ("EURUSD=X", assets.CURRENCY),
    ("VFIAX", assets.MUTUAL_FUND),
    ("FXAIX", assets.MUTUAL_FUND),
])
def test_symbol_shape_is_a_usable_fallback(symbol, expected):
    """When the provider can't say — a cold cache, a miss — the ticker itself
    is informative enough for these shapes."""
    assert assets.classify(symbol, None) == expected


def test_unknown_rather_than_a_wrong_guess():
    assert assets.classify("AAPL", None) == assets.UNKNOWN
    assert assets.classify("", None) == assets.UNKNOWN


def test_quote_type_beats_the_symbol_heuristic():
    # A five-letter X ticker that is genuinely an equity.
    assert assets.classify("XXXXX", "EQUITY") == assets.EQUITY


# --- capabilities ----------------------------------------------------------
def test_crypto_has_no_earnings_based_metrics():
    caps = assets.capabilities(assets.CRYPTO)
    assert caps["pe"] is False
    assert caps["dividends"] is False
    assert caps["earnings"] is False
    assert caps["volume"] is True          # crypto does have volume


def test_mutual_funds_have_no_intraday_anything():
    caps = assets.capabilities(assets.MUTUAL_FUND)
    assert caps["intraday"] is False
    assert caps["day_tradeable"] is False
    assert caps["volume"] is False
    assert caps["bid_ask"] is False
    assert caps["holdings"] is True        # they do have holdings


def test_only_crypto_and_currency_are_continuous():
    assert assets.is_continuous(assets.CRYPTO)
    assert assets.is_continuous(assets.CURRENCY)
    assert not assets.is_continuous(assets.EQUITY)
    assert not assets.is_continuous(assets.MUTUAL_FUND)


def test_mutual_funds_are_not_offered_intraday_timeframes():
    tf = assets.timeframes(assets.MUTUAL_FUND)
    assert "1D" not in tf and "5D" not in tf
    assert "1mo" in tf
    assert "1D" in assets.timeframes(assets.EQUITY)


def test_describe_bundles_class_and_capabilities():
    d = assets.describe("BTC-USD", "CRYPTOCURRENCY")
    assert d["asset_class"] == assets.CRYPTO
    assert d["continuous"] is True
    assert d["label"] == "Crypto"
    assert d["trades"] == "24/7"


# --- session handling ------------------------------------------------------
def _day(day, hours):
    return [f"{day} {h}" for h in hours]


def _candles(dates):
    n = len(dates)
    return {"dates": dates, "open": [100.0] * n, "high": [101.0] * n,
            "low": [99.0] * n, "close": [100.0] * n, "volume": [10.0] * n}


def test_continuous_session_keeps_the_whole_utc_day():
    """The equity filter carved 09:30-16:00 out of a 24/7 market, so pivots and
    VWAP were computed from an arbitrary six hours."""
    dates = _day("2026-09-18", ["00:00", "03:00", "09:45", "14:00", "22:00"])
    out, status = daytrade.continuous_session(_candles(dates))
    assert status == "live"
    assert len(out["dates"]) == 5          # nothing dropped


def test_continuous_session_still_splits_on_the_day():
    dates = _day("2026-09-17", ["22:00"]) + _day("2026-09-18", ["01:00", "02:00"])
    out, _ = daytrade.continuous_session(_candles(dates))
    assert [d[:10] for d in out["dates"]] == ["2026-09-18"] * 2


def test_regular_hours_still_filters_equities():
    dates = _day("2026-09-18", ["04:00", "09:45", "14:00", "18:00"])
    out, status = daytrade.regular_hours(_candles(dates))
    assert status == "live"
    assert len(out["dates"]) == 2          # only 09:45 and 14:00


def test_daytrade_refuses_to_invent_a_session_for_a_mutual_fund():
    out = daytrade.daytrade_levels("VFIAX", {}, {}, assets.MUTUAL_FUND)
    assert out["applicable"] is False
    assert "NAV" in out["reason"]
    assert out["session"] == {} and out["pivots"] == {}


def test_daytrade_marks_crypto_as_continuous():
    dates = _day("2026-09-18", [f"{h:02d}:00" for h in range(24)])
    daily = {"dates": ["2026-09-17", "2026-09-18"], "open": [100.0] * 2,
             "high": [105.0] * 2, "low": [95.0] * 2, "close": [100.0] * 2,
             "volume": [1.0] * 2}
    out = daytrade.daytrade_levels("BTC-USD", _candles(dates), daily, assets.CRYPTO)
    assert out["applicable"] is True
    assert out["continuous"] is True
    assert out["session"]["bars"] == 24     # the whole day, not a 6.5h slice


def test_equity_is_not_marked_continuous():
    dates = _day("2026-09-18", ["09:45", "10:00", "14:00"])
    daily = {"dates": ["2026-09-17", "2026-09-18"], "open": [100.0] * 2,
             "high": [105.0] * 2, "low": [95.0] * 2, "close": [100.0] * 2,
             "volume": [1.0] * 2}
    out = daytrade.daytrade_levels("AAPL", _candles(dates), daily, assets.EQUITY)
    assert out["continuous"] is False


# --- provider delegation ---------------------------------------------------
def test_finnhub_delegates_classes_it_cannot_quote():
    """Finnhub's /quote and /stock/profile2 are equities-only, so crypto came
    back zeroed and was reported as an unknown ticker."""
    from core.data import FinnhubProvider
    for symbol in ("BTC-USD", "ETH-USD", "^GSPC", "VFIAX"):
        assert assets.classify(symbol) in FinnhubProvider._DELEGATED, symbol


def test_equities_are_not_delegated():
    from core.data import FinnhubProvider
    assert assets.classify("AAPL", "EQUITY") not in FinnhubProvider._DELEGATED
    assert assets.classify("SPY", "ETF") not in FinnhubProvider._DELEGATED
