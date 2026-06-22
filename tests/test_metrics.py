from core.metrics import (
    total_return_pct, annualized_volatility_pct, max_drawdown_pct,
    moving_average, analyze_history, portfolio_summary, _trend_signal,
)
from core.data import History
import pytest


def test_total_return_positive():
    assert total_return_pct([100, 110]) == pytest.approx(10.0)


def test_total_return_negative():
    assert total_return_pct([100, 90]) == pytest.approx(-10.0)


def test_total_return_flat():
    assert total_return_pct([100] * 5) == 0.0


def test_volatility_non_negative():
    v = annualized_volatility_pct([100, 101, 99, 102, 98])
    assert v >= 0


def test_volatility_zero_for_flat():
    assert annualized_volatility_pct([100] * 10) == 0.0


def test_max_drawdown():
    dd = max_drawdown_pct([100, 110, 95, 105, 90, 115])
    assert dd < 0
    assert dd > -20


def test_moving_average_last_window():
    assert moving_average([1, 2, 3, 4, 5], 3) == 4.0


def test_moving_average_too_short():
    assert moving_average([1, 2], 5) is None


def test_trend_strong_uptrend():
    assert _trend_signal(150, 100, 90) == "strong-uptrend"


def test_trend_strong_downtrend():
    assert _trend_signal(80, 100, 120) == "strong-downtrend"


def test_trend_uptrend():
    assert _trend_signal(110, 100, 115) == "uptrend"


def test_trend_downtrend():
    assert _trend_signal(90, 100, 85) == "downtrend"


def test_trend_insufficient_data():
    assert _trend_signal(None, 100, 90) == "insufficient-data"


def test_analyze_history_keys():
    hist = History("AAPL", ["2024-01-01", "2024-01-02"], [100, 110])
    result = analyze_history(hist)
    expected_keys = {"symbol", "points", "last", "total_return_pct",
                     "annualized_volatility_pct", "max_drawdown_pct",
                     "ma50", "ma200", "trend"}
    assert expected_keys.issubset(result.keys())
    assert result["symbol"] == "AAPL"
    assert result["total_return_pct"] == pytest.approx(10.0)


def test_portfolio_summary():
    class FakeQuote:
        symbol = "AAPL"
        name = "Apple"
        price = 150
        change = 5
        change_pct = 3.45
        currency = "USD"
        pe = 25
        market_cap = 2_500_000_000_000

        def to_dict(self):
            return {"symbol": self.symbol, "name": self.name, "price": self.price,
                    "change": self.change, "change_pct": self.change_pct,
                    "currency": self.currency, "pe": self.pe, "market_cap": self.market_cap}

    quotes = [FakeQuote()]
    analyses = [{"symbol": "AAPL", "total_return_pct": 10.0,
                 "annualized_volatility_pct": 15.0, "max_drawdown_pct": -8.0,
                 "points": 2}]
    summary = portfolio_summary(quotes, analyses)
    assert summary["n_symbols"] == 1
    assert summary["gainers"] == 1
    assert summary["losers"] == 0
    assert summary["best_performer"] == "AAPL"
