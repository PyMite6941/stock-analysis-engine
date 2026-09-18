"""Read a screenshot of transaction history into structured positions.

Point a phone at a broker app, or screenshot a confirmation email, and get the
trades out without retyping them.

The hard rule here: **nothing extracted is ever saved automatically.** OCR
misreads decimal points, confuses 1,050 with 1.050, and will happily invent a
plausible-looking number for a smudged cell. Everything below returns rows for
a human to check, with a per-row confidence and a list of what looked doubtful,
and the UI requires an explicit confirmation before any of it touches the
portfolio. A silently wrong cost basis is exactly the failure this codebase has
been chasing all along.

Uses the same provider chain as the chat analyst, but a vision-capable model —
Groq's Llama 4 Scout and OpenRouter's equivalents take images in the standard
OpenAI multimodal format.
"""

from __future__ import annotations

import base64
import json
import os
import re

import httpx

# Vision-capable models, tried in order. Overridable per provider.
_VISION_PROVIDERS = [
    ("GROQ_API_KEY", "https://api.groq.com/openai/v1",
     "GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct"),
    ("OPENROUTER_API_KEY", "https://openrouter.ai/api/v1",
     "OPENROUTER_VISION_MODEL", "meta-llama/llama-4-scout"),
]

# Groq rejects base64 payloads over ~4MB; keep a margin for the JSON envelope.
MAX_IMAGE_BYTES = 4 * 1024 * 1024
ALLOWED_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"}

EXTRACT_PROMPT = """You are reading a screenshot of a brokerage or crypto \
transaction history. Extract every BUY or SELL you can see.

Return ONLY a JSON object, no prose, in exactly this shape:

{
  "rows": [
    {
      "symbol": "AAPL",
      "side": "buy",
      "shares": 10,
      "price": 178.50,
      "date": "2026-09-01",
      "time": "09:45",
      "confidence": "high",
      "note": "anything ambiguous about this row"
    }
  ],
  "warnings": ["things you could not read or had to infer"]
}

Rules, in order of importance:

1. NEVER guess a number you cannot actually read. If a digit is unclear, set
   that field to null and say so in `note`. A null is useful; a wrong number is
   worse than nothing because it looks correct.
2. `price` is the price PER SHARE or PER UNIT. If the screenshot only shows a
   total, divide by the quantity and say you did so in `note`. If you cannot
   tell whether a figure is per-unit or a total, set price to null and explain.
3. `side` is "buy" or "sell". If a row is a dividend, transfer, fee, deposit or
   interest payment, skip it entirely — this only tracks trades.
4. Dates as YYYY-MM-DD. Time as HH:MM 24-hour, or null if not shown. If the
   year is missing, leave `date` null rather than assuming one.
5. `confidence` is "high", "medium" or "low" for that row specifically, based on
   how legible it was.
6. Symbols as the exchange ticker in capitals. Crypto as BTC-USD style. If the
   image shows only a company name, put your best ticker guess in `symbol` and
   flag it in `note`.
7. If the image contains no transaction history at all, return {"rows": [],
   "warnings": ["no transaction history found in this image"]}.
"""


class NoVisionProvider(RuntimeError):
    pass


class ImageTooLarge(ValueError):
    pass


def _providers():
    for env_key, base, model_env, default_model in _VISION_PROVIDERS:
        key = os.environ.get(env_key)
        if key:
            yield {
                "name": env_key.replace("_API_KEY", "").lower(),
                "api_key": key,
                "base_url": base,
                "model": os.environ.get(model_env, default_model),
            }


def _extract_json(text: str) -> dict:
    """Pull the JSON object out of a reply that may be wrapped in prose/fences."""
    text = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            text = text[start:end + 1]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"The model did not return readable JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise ValueError("Expected a JSON object from the model.")
    return parsed


def _clean_number(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("$", "").replace(",", "").replace("%", "")
    if not s:
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    try:
        n = float(s)
    except ValueError:
        return None
    return -n if neg else n


def normalise_rows(payload: dict) -> dict:
    """Validate and tidy what the model returned.

    Rows missing a symbol, a quantity or a price are kept but marked
    `needs_review`, because a half-read row still tells the user which trade to
    go and check — dropping it silently would hide the gap.
    """
    rows_in = payload.get("rows")
    if not isinstance(rows_in, list):
        rows_in = []

    rows = []
    for raw in rows_in:
        if not isinstance(raw, dict):
            continue
        symbol = str(raw.get("symbol") or "").strip().upper()
        shares = _clean_number(raw.get("shares"))
        price = _clean_number(raw.get("price"))
        side = str(raw.get("side") or "buy").strip().lower()
        if side not in ("buy", "sell"):
            side = "buy"

        date = str(raw.get("date") or "").strip()[:10] or None
        if date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            date = None
        time = str(raw.get("time") or "").strip()[:5] or None
        if time and not re.fullmatch(r"\d{2}:\d{2}", time):
            time = None

        confidence = str(raw.get("confidence") or "medium").strip().lower()
        if confidence not in ("high", "medium", "low"):
            confidence = "medium"

        missing = [name for name, val in
                   (("symbol", symbol), ("shares", shares), ("price", price))
                   if not val]
        rows.append({
            "symbol": symbol or None,
            "side": side,
            "shares": abs(shares) if shares is not None else None,
            "price": price,
            "date": date,
            "time": time,
            # Combined stamp in the shape the positions store expects.
            "opened": f"{date} {time}" if date and time else date,
            "confidence": confidence,
            "note": str(raw.get("note") or "").strip() or None,
            "needs_review": bool(missing) or confidence == "low",
            "missing": missing,
        })

    warnings = payload.get("warnings")
    warnings = [str(w) for w in warnings] if isinstance(warnings, list) else []

    return {
        "rows": rows,
        "warnings": warnings,
        "n_rows": len(rows),
        "n_need_review": sum(1 for r in rows if r["needs_review"]),
    }


def read_transactions(image_bytes: bytes, content_type: str,
                      hint: str | None = None) -> dict:
    """Send one image to a vision model and return candidate transaction rows."""
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise ImageTooLarge(
            f"Image is {len(image_bytes) // 1024} KB; the limit is "
            f"{MAX_IMAGE_BYTES // 1024} KB. Crop it or lower the resolution.")

    ctype = (content_type or "image/png").split(";")[0].strip().lower()
    if ctype not in ALLOWED_TYPES:
        raise ValueError(f"Unsupported image type {ctype!r}. "
                         f"Use PNG, JPEG, WEBP or GIF.")

    providers = list(_providers())
    if not providers:
        raise NoVisionProvider(
            "Reading a photo needs an AI key. Set GROQ_API_KEY (or "
            "OPENROUTER_API_KEY) and redeploy. You can still type trades in or "
            "import a CSV without one.")

    b64 = base64.b64encode(image_bytes).decode("ascii")
    prompt = EXTRACT_PROMPT
    if hint:
        prompt += f"\n\nContext from the user about this image: {hint[:400]}"

    messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url",
             "image_url": {"url": f"data:{ctype};base64,{b64}"}},
        ],
    }]

    last_err: Exception | None = None
    for p in providers:
        try:
            r = httpx.post(
                f"{p['base_url']}/chat/completions",
                headers={
                    "Authorization": f"Bearer {p['api_key']}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://localhost:5173",
                    "X-Title": "Stock Analysis Engine",
                },
                json={
                    "model": p["model"],
                    "messages": messages,
                    # Low temperature: this is transcription, not writing.
                    "temperature": 0.1,
                    "max_tokens": 2000,
                },
                timeout=90,
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            out = normalise_rows(_extract_json(content))
            out["provider"] = p["name"]
            out["model"] = p["model"]
            return out
        except Exception as e:  # noqa: BLE001 — try the next provider
            last_err = e
            continue

    raise RuntimeError(f"Could not read the image. Last error: {last_err}")
