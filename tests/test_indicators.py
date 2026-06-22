from core.indicators import sma, ema, rsi, macd, bollinger, compute_all
import pytest


def test_sma_basic():
    assert sma([1, 2, 3, 4, 5], 3) == [None, None, 2.0, 3.0, 4.0]


def test_sma_shorter_than_period():
    assert sma([1, 2], 5) == [None, None]


def test_ema_length():
    values = [1] * 20
    result = ema(values, 10)
    assert len(result) == 20
    assert all(v is not None for v in result[10:])


def test_ema_increases_with_trend():
    values = list(range(1, 31))
    result = ema(values, 5)
    assert result[-1] > result[-2]


def test_rsi_out_of_bounds():
    r = rsi([1] * 20, 14)
    assert r[-1] is not None
    assert 0 <= r[-1] <= 100


def test_rsi_overbought():
    values = [10 + i for i in range(20)] + [10 + i for i in range(20)]
    r = rsi(values, 14)
    assert r[-1] > 50


def test_macd_returns_tuple():
    result = macd(list(range(1, 50)), 12, 26, 9)
    assert len(result) == 3
    assert len(result[0]) == 49
    assert len(result[1]) == 49
    assert len(result[2]) == 49


def test_macd_histogram_nonzero():
    line, signal, hist = macd(list(range(1, 100)), 12, 26, 9)
    assert abs(sum(hist[-10:])) > 0


def test_bollinger_returns_tuple():
    mid, upper, lower = bollinger([float(i) for i in range(1, 30)], 20, 2)
    assert len(mid) == 29
    assert len(upper) == 29
    assert len(lower) == 29


def test_bollinger_bands_ordering():
    mid, upper, lower = bollinger([float(i) for i in range(1, 50)], 20, 2)
    assert all(u >= m >= l for u, m, l in zip(upper, mid, lower) if u is not None)


def test_compute_all_keys():
    values = [float(i) for i in range(1, 60)]
    result = compute_all(values)
    expected_keys = {"sma20", "sma50", "sma200", "ema20",
                     "bb_mid", "bb_upper", "bb_lower",
                     "rsi", "macd", "macd_signal", "macd_hist"}
    assert expected_keys.issubset(result.keys())


def test_compute_all_lengths():
    values = [float(i) for i in range(1, 61)]
    result = compute_all(values)
    for key, arr in result.items():
        assert len(arr) == 60, f"{key} length mismatch"
