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


def test_gives_up_after_the_retry_budget(monkeypatch):
    data._CACHE.clear()
    p, ticker = _provider_with(
        monkeypatch, [_EmptyFrame()] * (data._YF_RETRIES + 2))
    c = p.candles("AAPL", "1mo", "1d")
    assert ticker.calls == data._YF_RETRIES
    assert c.close == []


def test_failure_is_not_cached(monkeypatch):
    """An empty result must not be served from cache for the full TTL."""
    data._CACHE.clear()
    p, _ = _provider_with(monkeypatch, [_EmptyFrame()] * 10)
    p.candles("AAPL", "1mo", "1d")
    assert not any(k.startswith("candles:AAPL") for k in data._CACHE)


def test_success_is_cached(monkeypatch):
    data._CACHE.clear()
    p, ticker = _provider_with(monkeypatch, [_Frame()])
    p.candles("AAPL", "1mo", "1d")
    p.candles("AAPL", "1mo", "1d")
    assert ticker.calls == 1           # second call served from cache
