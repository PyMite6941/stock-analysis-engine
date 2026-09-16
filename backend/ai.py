"""AI analysis + chat. Online-only — never imported by the offline Streamlit app.

Groq and OpenRouter both speak the OpenAI Chat Completions wire format, so one
client handles both. We try providers in order (Groq first, OpenRouter as
fallback) so a dead key or rate limit on one degrades gracefully — same pattern
as PixelCode. Keys live server-side only; the React app never sees them.
"""

from __future__ import annotations

import json
import os
import httpx


# Each provider: (env key, base url, default model env, hard-coded default model)
#
# Groq decommissioned llama-3.3-70b-versatile on 2026-06-17; requests for it now
# fail outright, which silently killed the analyst. gpt-oss-120b is Groq's own
# named replacement. Re-check https://console.groq.com/docs/deprecations before
# assuming any of these still resolve.
_PROVIDERS = [
    ("GROQ_API_KEY", "https://api.groq.com/openai/v1",
     "GROQ_MODEL", "openai/gpt-oss-120b"),
    ("OPENROUTER_API_KEY", "https://openrouter.ai/api/v1",
     "OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct"),
]

SYSTEM_PROMPT = (
    "You are a sharp, plain-spoken equity research assistant embedded in a stock "
    "analysis dashboard. You are given live quotes and computed metrics for the "
    "symbols the user is looking at. Ground every claim in that data — cite the "
    "actual numbers. Be direct about risk. When the data doesn't support a "
    "conclusion, say so. You are not a licensed advisor; do not give buy/sell "
    "directives — explain tradeoffs and let the user decide. Keep answers tight."
)

# Mode-specific addenda. The dashboard's mode switch changes who is reading, so
# it has to change how the analyst talks — a beginner and a scalper need
# genuinely different answers to the same question, not the same answer reworded.
MODE_PROMPTS = {
    "beginner": (
        "\n\nTHE USER IS NEW TO INVESTING. Rules for this conversation:\n"
        "- Write at a level someone who has never bought a stock can follow.\n"
        "- The FIRST time you use any term of art (P/E, volatility, drawdown, "
        "RSI, MACD, market cap, support/resistance, VWAP, ATR), define it in a "
        "short parenthetical immediately after. Never assume it is known.\n"
        "- Prefer dollars over percentages when illustrating an outcome, and "
        "percentages over ratios.\n"
        "- Lead with the single most important thing, then the detail.\n"
        "- Actively name the beginner traps that apply: buying purely because a "
        "stock went up, putting everything in one name, confusing a good company "
        "with a good price, and mistaking a short winning streak for skill.\n"
        "- Be encouraging but never hype. Never predict a specific future price "
        "as if it were known. If the honest answer is 'nobody can know that', "
        "say exactly that.\n"
        "- Keep it to a few short paragraphs or a tight bullet list."
    ),
    "daytrader": (
        "\n\nTHE USER IS DAY TRADING and may hold open positions (see the "
        "positions block if present). Rules for this conversation:\n"
        "- Assume fluency. Skip definitions and get to the level, the trigger, "
        "and the invalidation.\n"
        "- Work from the intraday data given: VWAP, opening range, floor pivots "
        "(P/R1-R3/S1-S3), ATR, range already used, and position within the "
        "session range. Quote the actual levels.\n"
        "- When discussing an open position, always state three things: "
        "unrealised P/L, where the thesis is invalidated, and what the ATR says "
        "about a sensible stop distance.\n"
        "- Frame everything as risk-per-trade, not as a prediction. If a setup "
        "is extended (range used well over 100% of ATR) or the risk/reward is "
        "poor, say so plainly.\n"
        "- Be blunt about the base rate: most day traders lose money, and "
        "position sizing matters more than entry selection.\n"
        "- Terse. Levels and reasoning, no preamble."
    ),
    "standard": "",
}


class NoProviderConfigured(RuntimeError):
    pass


def _available_providers():
    for env_key, base, model_env, default_model in _PROVIDERS:
        api_key = os.environ.get(env_key)
        if api_key:
            yield {
                "name": env_key.replace("_API_KEY", "").lower(),
                "api_key": api_key,
                "base_url": base,
                "model": os.environ.get(model_env, default_model),
            }


def _build_messages(user_messages: list[dict], data_context: dict | None,
                    mode: str = "standard") -> list[dict]:
    msgs = [{"role": "system",
             "content": SYSTEM_PROMPT + MODE_PROMPTS.get(mode, "")}]
    if data_context:
        msgs.append({
            "role": "system",
            "content": "Current dashboard data (JSON). These are the numbers on "
                       "the user's screen — use them, don't invent others:\n"
                       + json.dumps(data_context, indent=2, default=str),
        })
    msgs.extend(user_messages)
    return msgs


def chat(user_messages: list[dict], data_context: dict | None = None,
         max_tokens: int = 1024, mode: str = "standard") -> dict:
    """Run a chat completion through the provider chain.

    `user_messages` is a list of {role, content} (roles: user/assistant).
    `mode` is "beginner" | "standard" | "daytrader" and changes the register.
    Returns {reply, provider, model, mode}. Raises NoProviderConfigured if no key.
    """
    providers = list(_available_providers())
    if not providers:
        raise NoProviderConfigured(
            "No AI key found. Set GROQ_API_KEY and/or OPENROUTER_API_KEY.")

    mode = mode if mode in MODE_PROMPTS else "standard"
    messages = _build_messages(user_messages, data_context, mode)
    # Beginners need room for the definitions the prompt demands.
    if mode == "beginner":
        max_tokens = max(max_tokens, 1400)
    last_err: Exception | None = None

    for p in providers:
        try:
            r = httpx.post(
                f"{p['base_url']}/chat/completions",
                headers={
                    "Authorization": f"Bearer {p['api_key']}",
                    "Content-Type": "application/json",
                    # OpenRouter likes these; Groq ignores them.
                    "HTTP-Referer": "http://localhost:5173",
                    "X-Title": "Stock Analysis Engine",
                },
                json={
                    "model": p["model"],
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": 0.3,
                },
                timeout=60,
            )
            r.raise_for_status()
            data = r.json()
            return {
                "reply": data["choices"][0]["message"]["content"],
                "provider": p["name"],
                "model": p["model"],
                "mode": mode,
            }
        except Exception as e:  # noqa: BLE001 — try the next provider
            last_err = e
            continue

    raise RuntimeError(f"All AI providers failed. Last error: {last_err}")
