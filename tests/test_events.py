"""The forward calendar: earnings and ex-dividend dates."""
from datetime import date, timedelta

from core import events


class Fund:
    """Stand-in for core.data.Fundamentals — only the dates matter here."""
    def __init__(self, earnings_date=None, ex_dividend_date=None,
                 forward_dividend=None):
        self.earnings_date = earnings_date
        self.ex_dividend_date = ex_dividend_date
        self.forward_dividend = forward_dividend


TODAY = date(2026, 9, 22)


def iso(days):
    return (TODAY + timedelta(days=days)).isoformat()


def test_upcoming_events_are_sorted_nearest_first():
    cal = events.build_calendar(
        {"NVDA": Fund(earnings_date=iso(20)),
         "AAPL": Fund(earnings_date=iso(3))}, as_of=TODAY)
    assert [e["symbol"] for e in cal["events"]] == ["AAPL", "NVDA"]
    assert cal["next"]["symbol"] == "AAPL"


def test_past_events_are_excluded():
    cal = events.build_calendar({"NVDA": Fund(earnings_date=iso(-5))},
                                as_of=TODAY)
    assert cal["n"] == 0
    assert cal["next"] is None


def test_events_beyond_the_window_are_excluded():
    cal = events.build_calendar({"NVDA": Fund(earnings_date=iso(200))},
                                within_days=90, as_of=TODAY)
    assert cal["n"] == 0


def test_urgency_bands():
    assert events.urgency(0) == "imminent"
    assert events.urgency(3) == "imminent"
    assert events.urgency(4) == "soon"
    assert events.urgency(14) == "soon"
    assert events.urgency(15) == "scheduled"
    assert events.urgency(-1) == "past"
    assert events.urgency(None) == "past"


def test_labels_read_like_english():
    assert events.event_for("X", events.EARNINGS, iso(0), TODAY)["label"] \
        == "Earnings today"
    assert events.event_for("X", events.EARNINGS, iso(1), TODAY)["label"] \
        == "Earnings tomorrow"
    assert events.event_for("X", events.EARNINGS, iso(9), TODAY)["label"] \
        == "Earnings in 9d"
    assert events.event_for("X", events.EX_DIVIDEND, iso(5), TODAY)["label"] \
        == "Ex-dividend in 5d"


def test_both_event_kinds_appear_for_one_symbol():
    cal = events.build_calendar(
        {"KO": Fund(earnings_date=iso(10), ex_dividend_date=iso(2),
                    forward_dividend=1.94)}, as_of=TODAY)
    kinds = [e["kind"] for e in cal["by_symbol"]["KO"]]
    assert kinds == [events.EX_DIVIDEND, events.EARNINGS]
    assert cal["by_symbol"]["KO"][0]["amount"] == 1.94


def test_badge_is_the_nearest_event_per_symbol():
    cal = events.build_calendar(
        {"KO": Fund(earnings_date=iso(10), ex_dividend_date=iso(2))},
        as_of=TODAY)
    assert events.badges(cal)["KO"]["kind"] == events.EX_DIVIDEND


def test_a_failed_symbol_is_skipped_not_fatal():
    cal = events.build_calendar(
        {"NVDA": Fund(earnings_date=iso(5)), "BROKEN": None}, as_of=TODAY)
    assert cal["n"] == 1


def test_unparseable_dates_are_dropped():
    cal = events.build_calendar({"X": Fund(earnings_date="soon-ish")},
                                as_of=TODAY)
    assert cal["n"] == 0


def test_timestamp_dates_parse():
    cal = events.build_calendar(
        {"X": Fund(earnings_date=f"{iso(5)}T13:30:00")}, as_of=TODAY)
    assert cal["n"] == 1
    assert cal["events"][0]["date"] == iso(5)


def test_dict_fundamentals_work_too():
    cal = events.build_calendar({"X": {"earnings_date": iso(4)}}, as_of=TODAY)
    assert cal["n"] == 1


def test_imminent_count():
    cal = events.build_calendar(
        {"A": Fund(earnings_date=iso(1)), "B": Fund(earnings_date=iso(2)),
         "C": Fund(earnings_date=iso(30))}, as_of=TODAY)
    assert cal["n_imminent"] == 2


def test_symbols_from_unions_watchlist_and_holdings():
    out = events.symbols_from(["aapl", "MSFT"], [{"symbol": "nvda"},
                                                 {"symbol": "AAPL"}])
    assert out == ["AAPL", "MSFT", "NVDA"]


def test_symbols_from_handles_empty():
    assert events.symbols_from([], []) == []
    assert events.symbols_from(None, None) == []


def test_csv_rows_have_a_header():
    cal = events.build_calendar({"X": Fund(earnings_date=iso(5))}, as_of=TODAY)
    grid = events.to_csv_rows(cal["events"])
    assert grid[0] == events.CSV_COLUMNS
    assert len(grid) == 2


# ---------------------------------------------------------------------------
# Picking the right earnings timestamp out of Yahoo's several
# ---------------------------------------------------------------------------
def test_next_earnings_prefers_the_upcoming_date_over_the_last_report():
    """Regression: the obvious field is the LAST report, not the next one.

    Reading `earningsTimestamp` alone returned a date months in the past for
    most symbols, so the calendar filtered every one of them out as history and
    showed an empty panel.
    """
    from datetime import datetime, timezone
    from core.data import _next_earnings_date

    def ts(d):
        return int(datetime(d.year, d.month, d.day,
                            tzinfo=timezone.utc).timestamp())

    past = date.today() - timedelta(days=55)
    future = date.today() + timedelta(days=37)
    info = {"earningsTimestamp": ts(past),
            "earningsTimestampStart": ts(future),
            "earningsTimestampEnd": ts(future)}
    assert _next_earnings_date(info) == future.isoformat()


def test_next_earnings_falls_back_to_the_last_report_when_none_scheduled():
    from datetime import datetime, timezone
    from core.data import _next_earnings_date

    past = date.today() - timedelta(days=20)
    stamp = int(datetime(past.year, past.month, past.day,
                         tzinfo=timezone.utc).timestamp())
    assert _next_earnings_date({"earningsTimestamp": stamp}) == past.isoformat()


def test_next_earnings_handles_nothing_at_all():
    from core.data import _next_earnings_date
    assert _next_earnings_date({}) is None
    assert _next_earnings_date({"earningsTimestamp": None}) is None


def test_estimated_dates_are_labelled():
    cal = events.build_calendar(
        {"X": {"earnings_date": iso(10), "earnings_date_estimated": True}},
        as_of=TODAY)
    e = cal["events"][0]
    assert e["estimated"] is True
    assert e["label"].endswith("(est.)")


def test_confirmed_dates_are_not_labelled_estimated():
    cal = events.build_calendar(
        {"X": {"earnings_date": iso(10), "earnings_date_estimated": False}},
        as_of=TODAY)
    assert "estimated" not in cal["events"][0]
    assert "(est.)" not in cal["events"][0]["label"]
