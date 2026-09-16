"""Intraday levels and session stats. Deterministic inputs, no network."""

import pytest

from core import daytrade


def bars(dates, o, h, l, c, v=None):
    return {"dates": dates, "open": o, "high": h, "low": l, "close": c,
            "volume": v if v is not None else [1000.0] * len(c)}


def session_bars(day="2026-09-15", n=78, start_hour=9, start_min=30):
    """n five-minute regular-hours bars for one day."""
    dates = []
    minute = start_hour * 60 + start_min
    for _ in range(n):
        dates.append(f"{day} {minute // 60:02d}:{minute % 60:02d}")
        minute += 5
    return dates


# --- true range / ATR ------------------------------------------------------
def test_true_range_includes_the_gap():
    tr = daytrade.true_range([12, 20], [10, 18], [11, 19])
    assert tr[0] == 2                      # first bar: plain high-low
    assert tr[1] == pytest.approx(9)       # gap from prev close 11 up to 20


def test_atr_is_wilder_smoothed():
    n = 30
    high = [11.0] * n
    low = [10.0] * n
    close = [10.5] * n
    assert daytrade.atr(high, low, close, 14) == pytest.approx(1.0)


def test_atr_needs_enough_bars():
    assert daytrade.atr([1, 2], [1, 2], [1, 2], 14) is None


# --- pivots ----------------------------------------------------------------
def test_classic_pivot_arithmetic():
    p = daytrade.pivot_points(110, 90, 100)
    assert p["pivot"] == pytest.approx(100.0)          # (110+90+100)/3
    assert p["r1"] == pytest.approx(110.0)             # 2P - low
    assert p["s1"] == pytest.approx(90.0)              # 2P - high
    assert p["r2"] == pytest.approx(120.0)             # P + range
    assert p["s2"] == pytest.approx(80.0)


def test_pivots_are_ordered():
    p = daytrade.pivot_points(105, 95, 102)
    assert p["s3"] < p["s2"] < p["s1"] < p["pivot"] < p["r1"] < p["r2"] < p["r3"]


# --- VWAP ------------------------------------------------------------------
def test_vwap_weights_by_volume():
    # Two bars at 10 and 20 typical price, but 3x the volume at 10.
    v = daytrade.vwap([10, 20], [10, 20], [10, 20], [300, 100])
    assert v == pytest.approx(12.5)


def test_vwap_without_volume_is_none():
    assert daytrade.vwap([10], [10], [10], [0]) is None


# --- regular-hours filter --------------------------------------------------
def test_regular_hours_strips_premarket_and_afterhours():
    dates = (["2026-09-15 04:00", "2026-09-15 09:25"]
             + session_bars(n=3)
             + ["2026-09-15 18:00"])
    n = len(dates)
    # Pre-market print is a wild outlier; it must not set the session high.
    highs = [999.0, 500.0, 101.0, 102.0, 103.0, 700.0]
    c = bars(dates, [100.0] * n, highs, [99.0] * n, [100.0] * n)
    out, status = daytrade.regular_hours(c)
    assert status == "live"
    assert len(out["dates"]) == 3
    assert max(out["high"]) == 103.0


def test_regular_hours_keeps_only_the_latest_day():
    dates = ["2026-09-14 10:00", "2026-09-15 10:00", "2026-09-15 10:05"]
    c = bars(dates, [1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3])
    out, status = daytrade.regular_hours(c)
    assert status == "live"
    assert out["dates"] == ["2026-09-15 10:00", "2026-09-15 10:05"]


def test_premarket_falls_back_to_last_completed_session():
    """Before the bell, two overnight prints are useless — use yesterday."""
    dates = ["2026-09-14 10:00", "2026-09-14 10:05",   # yesterday's session
             "2026-09-15 04:00", "2026-09-15 06:00"]   # today, pre-market only
    c = bars(dates, [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4])
    out, status = daytrade.regular_hours(c)
    assert status == "premarket"
    assert out["dates"] == ["2026-09-14 10:00", "2026-09-14 10:05"]


def test_regular_hours_extended_when_no_session_anywhere():
    dates = ["2026-09-15 05:00", "2026-09-15 06:00"]
    c = bars(dates, [1, 2], [1, 2], [1, 2], [1, 2])
    out, status = daytrade.regular_hours(c)
    assert status == "extended"
    assert len(out["dates"]) == 2


# --- session stats ---------------------------------------------------------
def test_session_stats_position_in_range():
    s = daytrade.session_stats([100], [110], [90], [105], [1000],
                               prev_close=100, daily_atr=20)
    assert s["range"] == 20
    assert s["position_in_range_pct"] == pytest.approx(75.0)   # 105 in 90..110
    assert s["range_used_pct"] == pytest.approx(100.0)         # range == ATR
    assert s["gap_pct"] == pytest.approx(0.0)
    assert s["change_pct"] == pytest.approx(5.0)


def test_session_stats_flags_extended_range():
    s = daytrade.session_stats([100], [140], [90], [130], [1000], daily_atr=10)
    assert s["range_used_pct"] > 100


def test_session_stats_handles_zero_range():
    s = daytrade.session_stats([100], [100], [100], [100], [0])
    assert s["position_in_range_pct"] is None


# --- opening range ---------------------------------------------------------
def test_opening_range_uses_first_bars_only():
    high = [10, 12, 11, 10, 9, 10, 99]
    low = [8, 9, 9, 8, 7, 8, 1]
    orr = daytrade.opening_range(high, low, bars=6)
    assert orr["high"] == 12 and orr["low"] == 7
    assert orr["range"] == 5


def test_opening_range_needs_enough_bars():
    assert daytrade.opening_range([1, 2], [1, 2], bars=6) == {}


# --- position sizing -------------------------------------------------------
def test_position_size_caps_the_loss():
    r = daytrade.position_size(25000, 1.0, 100.0, 98.0)
    assert r["risk_dollars"] == pytest.approx(250.0)
    assert r["risk_per_share"] == pytest.approx(2.0)
    assert r["shares"] == 125                      # 250 / 2
    assert r["position_value"] == pytest.approx(12500.0)


def test_wider_stop_means_fewer_shares():
    tight = daytrade.position_size(10000, 1.0, 100, 99)
    wide = daytrade.position_size(10000, 1.0, 100, 95)
    assert wide["shares"] < tight["shares"]
    # Same dollars at risk either way — that's the whole point.
    assert wide["risk_dollars"] == tight["risk_dollars"]


def test_position_size_rejects_nonsense():
    assert daytrade.position_size(0, 1, 100, 95) == {}
    assert daytrade.position_size(10000, 1, 100, 100) == {}   # zero-width stop
    assert daytrade.position_size(10000, 0, 100, 95) == {}


# --- bundle ----------------------------------------------------------------
def test_daytrade_levels_end_to_end():
    dates = session_bars(n=78)
    n = len(dates)
    close = [330 + (i % 10) * 0.2 for i in range(n)]
    intraday = bars(dates, close, [c + 0.5 for c in close],
                    [c - 0.5 for c in close], close, [1000.0] * n)
    d_dates = ["2026-09-11", "2026-09-14", "2026-09-15"]
    daily = bars(d_dates * 10, [330.0] * 30, [335.0] * 30, [325.0] * 30,
                 [330.0] * 30)
    daily["dates"] = [f"2026-08-{i + 1:02d}" for i in range(27)] + d_dates

    out = daytrade.daytrade_levels("AAPL", intraday, daily)
    assert out["symbol"] == "AAPL"
    assert out["session_date"] == "2026-09-15"
    assert out["session"]["bars"] == 78
    assert out["session_status"] == "live"
    assert out["vwap"] is not None
    assert out["pivots"]["pivot"] == pytest.approx((335 + 325 + 330) / 3)
    assert out["stops"]["long"]["tight_1x"] < out["last"]
    assert out["stops"]["short"]["tight_1x"] > out["last"]


def test_daytrade_levels_survives_empty_intraday():
    """Before the open there may be no bars at all — don't explode."""
    out = daytrade.daytrade_levels(
        "AAPL", bars([], [], [], [], []),
        bars(["2026-09-14", "2026-09-15"], [1, 2], [1, 2], [1, 2], [1, 2]))
    assert out["symbol"] == "AAPL"
    assert out["session"] == {}


def test_premarket_pivots_come_from_the_shown_session():
    """Pre-market, pivots must describe the session ABOUT to open, i.e. be
    derived from the last completed session rather than the one before it."""
    intr_dates = (["2026-09-14 " + f"{9 + i // 12:02d}:{(30 + 5 * i) % 60:02d}"
                   for i in range(12)]
                  + ["2026-09-15 04:00"])
    n = len(intr_dates)
    intraday = bars(intr_dates, [100.0] * n, [101.0] * n, [99.0] * n, [100.0] * n)

    daily = {
        "dates": ["2026-09-11", "2026-09-14"],
        "open": [200.0, 300.0], "high": [210.0, 330.0],
        "low": [190.0, 270.0], "close": [200.0, 300.0],
        "volume": [1.0, 1.0],
    }
    out = daytrade.daytrade_levels("X", intraday, daily)
    assert out["session_status"] == "premarket"
    # Must use the 2026-09-14 bar (330/270/300), not the 2026-09-11 one.
    assert out["pivots"]["pivot"] == pytest.approx((330 + 270 + 300) / 3)
