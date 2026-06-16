"""Vercel serverless entrypoint for the FastAPI backend.

Vercel's @vercel/python runtime serves any `app` ASGI object found in a file
under /api. We just re-export the real app from backend/main.py. All routes are
already namespaced under /api/, and vercel.json rewrites /api/* to this function.

Production note: yfinance is unreliable from cloud IPs — set DATA_PROVIDER=finnhub
and FINNHUB_API_KEY in the Vercel project's environment variables.
"""

import os
import sys

# Make the repo root importable so `core` and `backend` packages resolve.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.main import app  # noqa: E402  (path insert must come first)

# Vercel looks for a module-level `app`.
__all__ = ["app"]
