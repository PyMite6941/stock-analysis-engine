"""FastAPI backend for the Stock Analysis Engine (online mode).

Run from the PROJECT ROOT so the shared `core` package imports cleanly:

    uvicorn backend.main:app --reload --port 8000

Endpoints
  GET  /api/health
  GET  /api/quotes?symbols=AAPL,MSFT
  GET  /api/history?symbol=AAPL&period=6mo
  POST /api/analyze       {symbols, period}        -> quotes + per-symbol metrics + summary
  POST /api/chat          {messages, symbols}      -> AI analysis grounded in current data
  GET  /api/download.csv?symbols=AAPL,MSFT&period=6mo
"""

from __future__ import annotations

import csv
import io
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core import data, metrics, indicators
from backend import ai
from backend.middleware import SecurityAndAuthMiddleware, logger

app = FastAPI(title="Stock Analysis Engine", version="0.1.0")

# Dev CORS: Vite dev server runs on 5173. Tighten for production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(SecurityAndAuthMiddleware)


@app.middleware("http")
async def edge_cache(request: Request, call_next):
    """Let Vercel's CDN serve repeat GETs instantly and refresh in the background,
    so the same symbol/timeframe doesn't re-hit the data provider every time."""
    response = await call_next(request)
    if request.method == "GET" and request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "public, s-maxage=15, stale-while-revalidate=60"
    return response


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class AnalyzeRequest(BaseModel):
    symbols: list[str]
    period: str = "6mo"


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    symbols: list[str] = []
    period: str = "6mo"


# ---------------------------------------------------------------------------
# Shared helper
# ---------------------------------------------------------------------------
def _analyze(symbols: list[str], period: str) -> dict:
    quotes = data.get_quotes(symbols)
    # Fetch per-symbol history in parallel instead of one-at-a-time.
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(symbols)))) as ex:
        hists = list(ex.map(lambda s: data.get_history(s, period), symbols))
    analyses, histories = [], {}
    for hist in hists:
        histories[hist.symbol] = hist.to_dict()
        analyses.append(metrics.analyze_history(hist))
    summary = metrics.portfolio_summary(quotes, analyses)
    return {
        "quotes": [q.to_dict() for q in quotes],
        "analyses": analyses,
        "histories": histories,
        "summary": summary,
    }


def _parse_symbols(symbols: str) -> list[str]:
    out = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not out:
        raise HTTPException(400, "No symbols provided")
    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/api/realtime-token")
def realtime_token():
    """Token for the browser's Finnhub WebSocket live ticker (free tier).

    Served at runtime (not baked into the JS bundle) so it can be rotated and so
    the client degrades to 30s polling when no token is set. Prefer a dedicated
    FINNHUB_WS_TOKEN (a throwaway free key) since it's exposed to the browser;
    falls back to FINNHUB_API_KEY.
    """
    import os
    return {"token": os.environ.get("FINNHUB_WS_TOKEN") or os.environ.get("FINNHUB_API_KEY") or None}


@app.get("/api/health")
def health():
    # Report the configured provider from env WITHOUT instantiating it — so this
    # never 500s just because the provider's deps/keys aren't present yet.
    import os
    return {
        "status": "ok",
        "data_provider": os.environ.get("DATA_PROVIDER", "yfinance"),
        "ai_configured": bool(os.environ.get("GROQ_API_KEY")
                              or os.environ.get("OPENROUTER_API_KEY")),
    }


@app.get("/api/quotes")
def quotes(symbols: str = Query(..., examples=["AAPL,MSFT,NVDA"])):
    return {"quotes": [q.to_dict() for q in data.get_quotes(_parse_symbols(symbols))]}


@app.get("/api/history")
def history(symbol: str, period: str = "6mo"):
    return data.get_history(symbol, period).to_dict()


@app.get("/api/fundamentals")
def fundamentals(symbol: str):
    """Detailed stats + company summary for the focused symbol's info panel."""
    return data.get_fundamentals(symbol).to_dict()


@app.get("/api/statistics")
def statistics(symbol: str):
    """Valuation, financial highlights, analyst insights, and quarterly earnings."""
    return data.get_statistics(symbol)


@app.get("/api/insights")
def insights(symbol: str):
    """Investor signals: trailing performance, risk profile, income, analyst
    recommendation split, and recent news. Performance/risk are computed from a
    1-year daily series; the rest comes from the data provider."""
    out = data.get_insights(symbol)
    candles = data.get_candles(symbol, "1y", "1d")
    closes, dates = candles.close, candles.dates
    out["performance"] = metrics.performance(dates, closes) if closes else {}
    out["risk"] = {
        "beta": out.get("beta"),
        "annualized_volatility_pct": round(metrics.annualized_volatility_pct(closes), 2) if closes else None,
        "max_drawdown_pct": round(metrics.max_drawdown_pct(closes), 2) if closes else None,
    }
    out["symbol"] = symbol.upper()
    return out


@app.get("/api/candles")
def candles(symbol: str, period: str = "6mo", interval: str = "1d"):
    """Full OHLCV + the standard indicator set, aligned to the same date axis.

    This is the data source for the main candlestick chart.
    """
    c = data.get_candles(symbol, period, interval)
    out = c.to_dict()
    out["indicators"] = indicators.compute_all(c.close) if c.close else {}
    return out


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    if not req.symbols:
        raise HTTPException(400, "No symbols provided")
    return _analyze([s.upper() for s in req.symbols], req.period)


@app.post("/api/chat")
def chat(req: ChatRequest):
    context = _analyze([s.upper() for s in req.symbols], req.period) if req.symbols else None
    if context:
        # Don't ship the full price series to the LLM — just quotes + stats.
        context = {"quotes": context["quotes"],
                   "analyses": context["analyses"],
                   "summary": context["summary"]}
    try:
        return ai.chat([m.model_dump() for m in req.messages], data_context=context)
    except ai.NoProviderConfigured as e:
        raise HTTPException(503, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"AI request failed: {e}")


@app.get("/api/download.csv")
def download_csv(symbols: str, period: str = "6mo"):
    result = _analyze(_parse_symbols(symbols), period)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["symbol", "name", "price", "change_pct", "pe", "market_cap",
                     "total_return_pct", "annualized_volatility_pct",
                     "max_drawdown_pct", "trend"])
    analyses_by_sym = {a["symbol"]: a for a in result["analyses"]}
    for q in result["quotes"]:
        a = analyses_by_sym.get(q["symbol"], {})
        writer.writerow([q["symbol"], q["name"], q["price"], q["change_pct"],
                         q["pe"], q["market_cap"], a.get("total_return_pct"),
                         a.get("annualized_volatility_pct"),
                         a.get("max_drawdown_pct"), a.get("trend")])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=stock_analysis.csv"},
    )
