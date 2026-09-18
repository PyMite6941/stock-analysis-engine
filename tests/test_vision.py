"""Photo-to-transactions extraction. Pure parsing; no model calls."""

import pytest

from backend import vision


# --- JSON extraction from a chatty model reply ----------------------------
def test_plain_json():
    assert vision._extract_json('{"rows": []}') == {"rows": []}


def test_json_inside_a_code_fence():
    reply = 'Here you go:\n```json\n{"rows": [{"symbol": "AAPL"}]}\n```\nHope that helps!'
    assert vision._extract_json(reply)["rows"][0]["symbol"] == "AAPL"


def test_json_surrounded_by_prose():
    reply = 'I found 1 trade. {"rows": [{"symbol": "X"}]} Let me know if wrong.'
    assert vision._extract_json(reply)["rows"][0]["symbol"] == "X"


def test_unreadable_reply_raises_valueerror():
    with pytest.raises(ValueError, match="readable JSON"):
        vision._extract_json("I couldn't read that image, sorry.")


def test_non_object_json_raises():
    with pytest.raises(ValueError):
        vision._extract_json("[1, 2, 3]")


# --- number cleaning -------------------------------------------------------
@pytest.mark.parametrize("raw,expected", [
    (10, 10.0), ("10", 10.0), ("$178.50", 178.5), ("1,050.25", 1050.25),
    ("(12.00)", -12.0), ("", None), (None, None), ("n/a", None), (True, None),
])
def test_clean_number(raw, expected):
    assert vision._clean_number(raw) == expected


# --- normalisation ---------------------------------------------------------
def test_good_row_is_ready_to_use():
    out = vision.normalise_rows({"rows": [{
        "symbol": "aapl", "side": "BUY", "shares": "10", "price": "$178.50",
        "date": "2026-09-01", "time": "09:45", "confidence": "high",
    }]})
    r = out["rows"][0]
    assert r["symbol"] == "AAPL"
    assert r["shares"] == 10 and r["price"] == 178.5
    assert r["opened"] == "2026-09-01 09:45"
    assert r["needs_review"] is False


def test_missing_price_is_flagged_not_dropped():
    """A half-read row still tells you which trade to go and check."""
    out = vision.normalise_rows({"rows": [{
        "symbol": "NVDA", "shares": 400, "price": None, "confidence": "low",
    }]})
    r = out["rows"][0]
    assert r["needs_review"] is True
    assert "price" in r["missing"]
    assert out["n_need_review"] == 1


def test_low_confidence_always_needs_review_even_when_complete():
    out = vision.normalise_rows({"rows": [{
        "symbol": "X", "shares": 1, "price": 1, "confidence": "low",
    }]})
    assert out["rows"][0]["needs_review"] is True


def test_a_bad_date_becomes_null_rather_than_a_guess():
    out = vision.normalise_rows({"rows": [{
        "symbol": "X", "shares": 1, "price": 1, "date": "last Tuesday",
    }]})
    assert out["rows"][0]["date"] is None
    assert out["rows"][0]["opened"] is None


def test_a_bad_time_is_dropped_but_the_date_survives():
    out = vision.normalise_rows({"rows": [{
        "symbol": "X", "shares": 1, "price": 1,
        "date": "2026-09-01", "time": "morning",
    }]})
    assert out["rows"][0]["opened"] == "2026-09-01"


def test_side_defaults_to_buy_and_rejects_nonsense():
    rows = vision.normalise_rows({"rows": [
        {"symbol": "A", "shares": 1, "price": 1, "side": "SELL"},
        {"symbol": "B", "shares": 1, "price": 1, "side": "dividend"},
    ]})["rows"]
    assert rows[0]["side"] == "sell"
    assert rows[1]["side"] == "buy"


def test_negative_quantity_is_normalised_to_positive():
    """Side carries the direction; a negative quantity would double-count it."""
    out = vision.normalise_rows({"rows": [{
        "symbol": "X", "shares": -5, "price": 10, "side": "sell",
    }]})
    assert out["rows"][0]["shares"] == 5


def test_junk_entries_are_skipped():
    out = vision.normalise_rows({"rows": ["not a dict", None, 42]})
    assert out["rows"] == [] and out["n_rows"] == 0


def test_missing_or_malformed_payload_is_survivable():
    assert vision.normalise_rows({})["rows"] == []
    assert vision.normalise_rows({"rows": "nope"})["rows"] == []
    assert vision.normalise_rows({"warnings": "nope"})["warnings"] == []


def test_warnings_pass_through():
    out = vision.normalise_rows({"rows": [], "warnings": ["bottom row cut off"]})
    assert out["warnings"] == ["bottom row cut off"]


# --- guards ----------------------------------------------------------------
def test_oversized_image_is_refused_before_any_network_call():
    with pytest.raises(vision.ImageTooLarge):
        vision.read_transactions(b"x" * (vision.MAX_IMAGE_BYTES + 1), "image/png")


def test_unsupported_type_is_refused():
    with pytest.raises(ValueError, match="Unsupported image type"):
        vision.read_transactions(b"x", "application/pdf")


def test_no_key_gives_an_actionable_message(monkeypatch):
    for k in ("GROQ_API_KEY", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(vision.NoVisionProvider, match="GROQ_API_KEY"):
        vision.read_transactions(b"x", "image/png")


# --- provider/model fallback chain ----------------------------------------
def test_each_provider_offers_several_models(monkeypatch):
    """Hosted model names churn. This shipped once pointing at a retired Llama
    4 Scout id and the only symptom was a 404 that read like a broken URL."""
    monkeypatch.setenv("GROQ_API_KEY", "x")
    monkeypatch.delenv("GROQ_VISION_MODEL", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    models = [p["model"] for p in vision._providers()]
    assert len(models) >= 2
    assert len(set(models)) == len(models)


def test_groq_is_tried_before_openrouter(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "x")
    monkeypatch.setenv("OPENROUTER_API_KEY", "y")
    monkeypatch.delenv("GROQ_VISION_MODEL", raising=False)
    monkeypatch.delenv("OPENROUTER_VISION_MODEL", raising=False)
    names = [p["name"] for p in vision._providers()]
    assert names.index("groq") < names.index("openrouter")


def test_an_explicit_model_pins_that_provider(monkeypatch):
    """Lets a known-good id be forced from the dashboard without a redeploy."""
    monkeypatch.setenv("GROQ_API_KEY", "x")
    monkeypatch.setenv("GROQ_VISION_MODEL", "pinned/model")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    models = [p["model"] for p in vision._providers()]
    assert models == ["pinned/model"]


def test_a_provider_with_no_key_contributes_nothing(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "x")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert all(p["name"] == "groq" for p in vision._providers())


def test_failure_names_every_model_it_tried(monkeypatch):
    """"Model not found" and "provider down" are both a 404 here; only the list
    of attempts distinguishes them."""
    monkeypatch.setenv("GROQ_API_KEY", "x")
    monkeypatch.delenv("GROQ_VISION_MODEL", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    def boom(*_a, **_k):
        raise RuntimeError("404 Not Found")

    monkeypatch.setattr(vision.httpx, "post", boom)
    with pytest.raises(RuntimeError, match="Tried groq:"):
        vision.read_transactions(b"fake-image-bytes", "image/png")


def test_a_later_model_can_rescue_an_earlier_404(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "x")
    monkeypatch.delenv("GROQ_VISION_MODEL", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    calls = []

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {
                "content": '{"rows": [{"symbol":"AAPL","shares":1,"price":2,'
                           '"confidence":"high"}], "warnings": []}'}}]}

    def flaky(url, **kwargs):
        calls.append(kwargs["json"]["model"])
        if len(calls) == 1:
            raise RuntimeError("404 model_not_found")
        return Resp()

    monkeypatch.setattr(vision.httpx, "post", flaky)
    out = vision.read_transactions(b"fake", "image/png")
    assert len(calls) == 2                    # first model 404'd, second worked
    assert out["rows"][0]["symbol"] == "AAPL"
    assert out["model"] == calls[1]
