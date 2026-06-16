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
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core import data, metrics
from backend import ai

app = FastAPI(title="Stock Analysis Engine", version="0.1.0")

# Dev CORS: Vite dev server runs on 5173. Tighten for production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    analyses, histories = [], {}
    for sym in symbols:
        hist = data.get_history(sym, period)
        histories[sym.upper()] = hist.to_dict()
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
