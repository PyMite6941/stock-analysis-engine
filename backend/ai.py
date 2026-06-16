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
_PROVIDERS = [
    ("GROQ_API_KEY", "https://api.groq.com/openai/v1",
     "GROQ_MODEL", "llama-3.3-70b-versatile"),
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


def _build_messages(user_messages: list[dict], data_context: dict | None) -> list[dict]:
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    if data_context:
        msgs.append({
            "role": "system",
            "content": "Current dashboard data (JSON):\n"
                       + json.dumps(data_context, indent=2, default=str),
        })
    msgs.extend(user_messages)
    return msgs


def chat(user_messages: list[dict], data_context: dict | None = None,
         max_tokens: int = 1024) -> dict:
    """Run a chat completion through the provider chain.

    `user_messages` is a list of {role, content} (roles: user/assistant).
    Returns {reply, provider, model}. Raises NoProviderConfigured if no key set.
    """
    providers = list(_available_providers())
    if not providers:
        raise NoProviderConfigured(
            "No AI key found. Set GROQ_API_KEY and/or OPENROUTER_API_KEY.")

    messages = _build_messages(user_messages, data_context)
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
            }
        except Exception as e:  # noqa: BLE001 — try the next provider
            last_err = e
            continue

    raise RuntimeError(f"All AI providers failed. Last error: {last_err}")
