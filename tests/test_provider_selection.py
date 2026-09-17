"""Provider auto-selection and yfinance throttle resilience. No network."""

import pytest

from core import data


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Every test starts with no provider env and no cached instance."""
    monkeypatch.delenv("DATA_PROVIDER", raising=False)
    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    data.reset_provider()
    yield
    data.reset_provider()


# --- selection -------------------------------------------------------------
def test_defaults_to_yfinance_with_no_config():
    assert data.choose_provider_name() == "yfinance"


def test_upgrades_to_hybrid_when_a_finnhub_key_exists(monkeypatch):
    """The whole point: deploying should need the KEY, not a second variable."""
    monkeypatch.setenv("FINNHUB_API_KEY", "test-key")
    assert data.choose_provider_name() == "hybrid"


def test_explicit_setting_beats_auto_selection(monkeypatch):
    monkeypatch.setenv("FINNHUB_API_KEY", "test-key")
    monkeypatch.setenv("DATA_PROVIDER", "yfinance")
    assert data.choose_provider_name() == "yfinance"


def test_setting_is_case_and_space_insensitive(monkeypatch):
    monkeypatch.setenv("DATA_PROVIDER", "  HYBRID  ")
    assert data.choose_provider_name() == "hybrid"


def test_blank_setting_is_treated_as_unset(monkeypatch):
    monkeypatch.setenv("DATA_PROVIDER", "   ")
    assert data.choose_provider_name() == "yfinance"
    monkeypatch.setenv("FINNHUB_API_KEY", "k")
    assert data.choose_provider_name() == "hybrid"


# --- graceful degradation --------------------------------------------------
def test_unknown_provider_falls_back_instead_of_raising(monkeypatch):
    """A typo in an env var should degrade the data, not 500 every route."""
    monkeypatch.setenv("DATA_PROVIDER", "nonsense")
    assert isinstance(data.get_provider(), data.YFinanceProvider)


def test_provider_that_cannot_construct_falls_back(monkeypatch):
    """finnhub without a key used to raise at import time and kill the API."""
    monkeypatch.setenv("DATA_PROVIDER", "finnhub")
    assert isinstance(data.get_provider(), data.YFinanceProvider)


def test_provider_instance_is_cached(monkeypatch):
    monkeypatch.setenv("DATA_PROVIDER", "yfinance")
    assert data.get_provider() is data.get_provider()


def test_reset_clears_the_cache(monkeypatch):
    monkeypatch.setenv("DATA_PROVIDER", "yfinance")
    first = data.get_provider()
    data.reset_provider()
    assert data.get_provider() is not first


# --- throttle resilience ---------------------------------------------------
class FakeHistory:
    """Stands in for yfinance's Ticker, returning a scripted sequence."""

    def __init__(self, frames):
        self._frames = list(frames)
        self.calls = 0

    def history(self, **_kwargs):
        self.calls += 1
        item = self._frames.pop(0) if self._frames else self._frames_last()
        if isinstance(item, Exception):
            raise item
        return item

    def _frames_last(self):
        return _EmptyFrame()


class _EmptyFrame:
    empty = True

    def dropna(self):
        return self

    @property
    def index(self):
        return []


class _Frame:
    """Minimal stand-in for a populated pandas frame."""

    empty = False

    def __init__(self, n=3):
        self._n = n

    def dropna(self):
        return self

    @property
    def index(self):
        import datetime as dt
        return [dt.datetime(2026, 9, d + 1) for d in range(self._n)]

    def __getitem__(self, key):
        class Col:
            values = [1.0, 2.0, 3.0]
        return Col()


def _provider_with(monkeypatch, frames):
    p = data.YFinanceProvider.__new__(data.YFinanceProvider)
    ticker = FakeHistory(frames)

    class FakeYF:
        @staticmethod
        def Ticker(_symbol):
            return ticker

    p._yf = FakeYF
    monkeypatch.setattr(data, "_YF_BACKOFF", 0)   # no sleeping in tests
    return p, ticker


def test_empty_frame_is_retried(monkeypatch):
    """Yahoo signals throttling with an EMPTY frame, not an error."""
    data._CACHE.clear()
    p, ticker = _provider_with(monkeypatch, [_EmptyFrame(), _EmptyFrame(), _Frame()])
    c = p.candles("AAPL", "1mo", "1d")
    assert ticker.calls == 3
    assert len(c.close) == 3          # succeeded on the third attempt


def test_exception_is_retried(monkeypatch):
    data._CACHE.clear()
    p, ticker = _provider_with(monkeypatch, [RuntimeError("boom"), _Frame()])
    c = p.candles("AAPL", "1mo", "1d")
    assert ticker.calls == 2
    assert len(c.close) == 3


def _no_fallback(monkeypatch):
    """Silence the keyless fallback so these tests stay offline and isolated."""
    monkeypatch.setattr(
        data, "yahoo_chart",
        lambda *_a, **_k: data.Candles("AAPL", [], [], [], [], [], []))


def test_gives_up_after_the_retry_budget(monkeypatch):
    data._CACHE.clear()
    _no_fallback(monkeypatch)
    p, ticker = _provider_with(
        monkeypatch, [_EmptyFrame()] * (data._YF_RETRIES + 2))
    c = p.candles("AAPL", "1mo", "1d")
    assert ticker.calls == data._YF_RETRIES
    assert c.close == []


def test_failure_is_not_cached(monkeypatch):
    """With BOTH sources empty, nothing is cached — the next request retries
    rather than serving an empty chart for the full TTL."""
    data._CACHE.clear()
    _no_fallback(monkeypatch)
    p, _ = _provider_with(monkeypatch, [_EmptyFrame()] * 10)
    p.candles("AAPL", "1mo", "1d")
    assert not any(k.startswith("candles:AAPL") for k in data._CACHE)


def test_success_is_cached(monkeypatch):
    data._CACHE.clear()
    p, ticker = _provider_with(monkeypatch, [_Frame()])
    p.candles("AAPL", "1mo", "1d")
    p.candles("AAPL", "1mo", "1d")
    assert ticker.calls == 1           # second call served from cache


# --- keyless Yahoo fallback ------------------------------------------------
class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"{self.status_code} error")

    def json(self):
        return self._payload


def _chart_payload(n=3, *, price=100.0, offset=-14400, closes=None):
    closes = closes or [price - 2, price - 1, price][:n]
    base = 1789047000
    return {"chart": {"result": [{
        "meta": {"symbol": "AAPL", "currency": "USD", "gmtoffset": offset,
                 "regularMarketPrice": price, "chartPreviousClose": 50.0,
                 "longName": "Apple Inc."},
        "timestamp": [base + i * 86400 for i in range(n)],
        "indicators": {"quote": [{
            "open": closes, "high": [c + 1 for c in closes],
            "low": [c - 1 for c in closes], "close": closes,
            "volume": [1000] * n}]},
    }]}}


def _patch_requests(monkeypatch, resp):
    import requests

    def fake_get(*_a, **_k):
        if isinstance(resp, Exception):
            raise resp
        return resp

    monkeypatch.setattr(requests, "get", fake_get)


def test_yahoo_chart_parses_bars(monkeypatch):
    _patch_requests(monkeypatch, _Resp(_chart_payload(3)))
    c = data.yahoo_chart("AAPL", "1mo", "1d")
    assert len(c.close) == 3
    assert c.symbol == "AAPL"
    assert c.close[-1] == 100.0


def test_yahoo_chart_drops_null_padded_bars(monkeypatch):
    payload = _chart_payload(3)
    payload["chart"]["result"][0]["indicators"]["quote"][0]["close"] = [98.0, None, 100.0]
    _patch_requests(monkeypatch, _Resp(payload))
    c = data.yahoo_chart("AAPL", "1mo", "1d")
    assert len(c.close) == 2          # the null bar is dropped, not interpolated


def test_yahoo_chart_shifts_intraday_to_exchange_time(monkeypatch):
    """The app encodes exchange wall-clock as fake-UTC; both paths must match."""
    _patch_requests(monkeypatch, _Resp(_chart_payload(1, offset=-14400)))
    daily = data.yahoo_chart("AAPL", "1d", "1d")
    _patch_requests(monkeypatch, _Resp(_chart_payload(1, offset=-14400)))
    intra = data.yahoo_chart("AAPL", "1d", "5m")
    # Intraday shifts by gmtoffset; daily does not.
    assert len(daily.dates[0]) == 10          # YYYY-MM-DD
    assert len(intra.dates[0]) == 16          # YYYY-MM-DD HH:MM


def test_yahoo_chart_returns_empty_on_error(monkeypatch):
    _patch_requests(monkeypatch, _Resp({}, status=404))
    assert data.yahoo_chart("NOPE", "1mo", "1d").close == []


def test_yahoo_chart_never_raises(monkeypatch):
    _patch_requests(monkeypatch, RuntimeError("network down"))
    assert data.yahoo_chart("AAPL", "1mo", "1d").close == []


def test_yahoo_quote_uses_prior_bar_not_chart_previous_close(monkeypatch):
    """Regression: chartPreviousClose is the close BEFORE the range, so using
    it reported a 5-day move as today's change (+5.4% on a -0.5% day)."""
    _patch_requests(monkeypatch, _Resp(
        _chart_payload(3, price=100.0, closes=[80.0, 99.0, 100.0])))
    q = data.yahoo_quote("AAPL")
    assert q.change == pytest.approx(1.0)        # 100 - 99, not 100 - 50
    assert q.change_pct == pytest.approx(1.0101, abs=0.01)


def test_yahoo_quote_returns_none_when_unavailable(monkeypatch):
    _patch_requests(monkeypatch, _Resp({}, status=404))
    assert data.yahoo_quote("NOPE") is None


def test_candles_fall_back_to_yahoo_when_yfinance_is_empty(monkeypatch):
    """The whole point: a throttled scraper must not produce an empty chart."""
    data._CACHE.clear()
    p, ticker = _provider_with(monkeypatch, [_EmptyFrame()] * 5)
    monkeypatch.setattr(
        data, "yahoo_chart",
        lambda *_a, **_k: data.Candles("AAPL", ["2026-09-16"], [1.0], [1.0],
                                       [1.0], [1.0], [1.0]))
    c = p.candles("AAPL", "1mo", "1d")
    assert ticker.calls == data._YF_RETRIES     # exhausted retries first
    assert len(c.close) == 1                    # then the fallback served it


def test_fallback_result_is_cached(monkeypatch):
    data._CACHE.clear()
    p, _ = _provider_with(monkeypatch, [_EmptyFrame()] * 10)
    monkeypatch.setattr(
        data, "yahoo_chart",
        lambda *_a, **_k: data.Candles("AAPL", ["2026-09-16"], [1.0], [1.0],
                                       [1.0], [1.0], [1.0]))
    p.candles("AAPL", "1mo", "1d")
    assert any(k.startswith("candles:AAPL") for k in data._CACHE)


def test_quote_falls_back_before_declaring_not_found(monkeypatch):
    """A throttled .info scrape must not be reported as an unknown ticker."""
    p = data.YFinanceProvider.__new__(data.YFinanceProvider)

    class FakeYF:
        @staticmethod
        def Ticker(_s):
            class T:
                fast_info = {}
                info = {}
            return T()

    p._yf = FakeYF
    monkeypatch.setattr(data, "_cache_get", lambda *_a, **_k: {})
    monkeypatch.setattr(
        data, "yahoo_quote",
        lambda s: data.Quote(symbol=s, name="Apple Inc.", price=332.41,
                             change=1.0, change_pct=0.3))
    q = p._quote_one("AAPL")
    assert q.not_found is False
    assert q.price == 332.41


def test_quote_still_reports_not_found_when_both_sources_fail(monkeypatch):
    p = data.YFinanceProvider.__new__(data.YFinanceProvider)

    class FakeYF:
        @staticmethod
        def Ticker(_s):
            class T:
                fast_info = {}
                info = {}
            return T()

    p._yf = FakeYF
    monkeypatch.setattr(data, "_cache_get", lambda *_a, **_k: {})
    monkeypatch.setattr(data, "yahoo_quote", lambda _s: None)
    assert p._quote_one("ZZZQQQ9").not_found is True
