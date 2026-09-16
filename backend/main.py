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

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from core import compare, data, daytrade, forecast, indicators, metrics, positions
from backend import ai, exports
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


@app.exception_handler(data.SymbolNotFound)
async def symbol_not_found(request: Request, exc: data.SymbolNotFound):
    """A typo'd ticker is a 404 with a readable message, not a generic failure.

    Without this the frontend shows "Request failed (500)" and people go looking
    for a connection problem that doesn't exist.
    """
    return JSONResponse(
        status_code=404,
        content={"detail": f"Stock/ETF not found: {exc.symbol}. "
                           f"Check the ticker symbol and try again.",
                 "symbol": exc.symbol, "error": "symbol_not_found"},
    )


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


class PositionIn(BaseModel):
    symbol: str
    shares: float
    cost_basis: float
    opened: Optional[str] = None
    note: Optional[str] = None
    id: Optional[str] = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    symbols: list[str] = []
    period: str = "6mo"
    # "beginner" | "standard" | "daytrader" — switches the analyst's register.
    mode: str = "standard"
    # The user's holdings, so the analyst can answer "how am I doing".
    positions: list[PositionIn] = []


class PortfolioRequest(BaseModel):
    positions: list[PositionIn] = []


class ExportRequest(BaseModel):
    positions: list[PositionIn] = []
    format: str = "csv"          # "csv" | "xlsx"
    include_analysis: bool = True


class CompareRequest(BaseModel):
    positions: list[PositionIn] = []
    period: str = "6mo"
    # Compared against the same window so "did I beat the market" is answerable.
    benchmark: Optional[str] = "SPY"
    format: str = "csv"


# ---------------------------------------------------------------------------
# Shared helper
# ---------------------------------------------------------------------------
def _analyze(symbols: list[str], period: str) -> dict:
    quotes = data.get_quotes(symbols)

    # Separate typos from real symbols before doing any more work. If nothing
    # resolved, that's a 404 for the whole request; if only some did, analyse
    # those and tell the UI which ones were bogus.
    unknown = [q.symbol for q in quotes if q.not_found]
    known = [q.symbol for q in quotes if not q.not_found]
    if not known:
        raise data.SymbolNotFound(", ".join(unknown) or ", ".join(symbols))

    # Fetch per-symbol history in parallel instead of one-at-a-time.
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(known)))) as ex:
        hists = list(ex.map(lambda s: data.get_history(s, period), known))
    analyses, histories = [], {}
    for hist in hists:
        histories[hist.symbol] = hist.to_dict()
        analyses.append(metrics.analyze_history(hist))
    good_quotes = [q for q in quotes if not q.not_found]
    summary = metrics.portfolio_summary(good_quotes, analyses)
    return {
        "quotes": [q.to_dict() for q in good_quotes],
        "analyses": analyses,
        "histories": histories,
        "summary": summary,
        "not_found": unknown,
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


@app.get("/api/holdings")
def holdings(symbol: str):
    """What an ETF / index fund owns. `is_fund: false` for ordinary stocks."""
    data.require_symbol(symbol)
    return data.get_holdings(symbol)


@app.get("/api/forecast")
def forecast_endpoint(symbol: str, period: str = "1y",
                      target: Optional[float] = None,
                      target_days: int = 21):
    """Trend projection, probability cone, signal score, risk stats, S/R levels.

    `target` adds the first-passage probability of touching that price within
    `target_days` — the question behind every limit order.
    """
    data.require_symbol(symbol)
    c = data.get_candles(symbol, period, "1d")
    if not c.close:
        raise HTTPException(422, f"No price history available for {symbol.upper()} "
                                 f"over {period}.")
    out = forecast.forecast(symbol, c.dates, c.open, c.high, c.low, c.close, c.volume)
    out["period"] = period
    if target:
        out["target"] = forecast.probability_of_touch(c.close, target, target_days)
    return out


@app.get("/api/daytrade")
def daytrade_endpoint(symbol: str, interval: str = "5m",
                      account_value: Optional[float] = None,
                      risk_pct: float = 1.0,
                      entry: Optional[float] = None,
                      stop: Optional[float] = None):
    """Intraday levels: VWAP, opening range, floor pivots, ATR, session stats.

    Pass account_value + entry + stop to get the share count that caps the loss
    at `risk_pct` of the account.
    """
    data.require_symbol(symbol)
    # 5 days rather than 1 so that pre-market (and Monday morning) can still fall
    # back to the last completed session instead of a handful of overnight prints.
    intraday = data.get_candles(symbol, "5d", interval).to_dict()
    daily = data.get_candles(symbol, "3mo", "1d").to_dict()
    out = daytrade.daytrade_levels(symbol, intraday, daily)
    out["interval"] = interval
    if account_value and entry and stop:
        out["sizing"] = daytrade.position_size(account_value, risk_pct, entry, stop)
    return out


@app.post("/api/portfolio")
def portfolio(req: PortfolioRequest):
    """Mark the user's holdings to market: cost, value, P/L, weights, day P/L."""
    parsed = positions.parse_positions([p.model_dump() for p in req.positions])
    if not parsed:
        return {"positions": [], "summary": positions.portfolio_summary([]),
                "by_symbol": []}
    quotes = data.get_quotes(sorted({p.symbol for p in parsed}))
    result = positions.value_portfolio(parsed, quotes)
    result["by_symbol"] = positions.aggregate_lots(result["positions"])
    result["unknown_symbols"] = [q.symbol for q in quotes if q.not_found]
    return result


@app.post("/api/portfolio/compare")
def portfolio_compare(req: CompareRequest):
    """Did these holdings gain or lose value over `period`?

    Reports the stock's period return AND the holder's since-purchase return
    separately, plus an optional benchmark, because they answer different
    questions and only one of them is about the market.
    """
    parsed = positions.parse_positions([p.model_dump() for p in req.positions])
    if not parsed:
        raise HTTPException(422, "No valid positions to compare.")

    symbols = sorted({p.symbol for p in parsed})
    quotes = data.get_quotes(symbols)
    known = [q.symbol for q in quotes if not q.not_found]
    if not known:
        raise data.SymbolNotFound(", ".join(symbols))

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(known)))) as ex:
        hists = list(ex.map(lambda s: data.get_history(s, req.period), known))
    histories = {h.symbol: h.to_dict() for h in hists}

    bench = None
    if req.benchmark:
        try:
            b = data.get_history(req.benchmark, req.period)
            bench = {"symbol": b.symbol, "dates": b.dates, "closes": b.closes}
        except Exception:  # noqa: BLE001 — comparison still works without it
            bench = None

    held = [p for p in parsed if p.symbol in known]
    out = compare.compare_positions(held, histories, quotes, req.period, bench)
    out["not_found"] = [q.symbol for q in quotes if q.not_found]
    return out


@app.post("/api/portfolio/compare/export")
def portfolio_compare_export(req: CompareRequest):
    """The period comparison as a CSV (default) or XLSX download."""
    result = portfolio_compare(req)
    rows = result["positions"]
    fmt = (req.format or "csv").lower()

    if fmt == "csv":
        body = exports.rows_to_csv(compare.to_csv_rows(rows))
        return Response(
            content=body, media_type="text/csv",
            headers={"Content-Disposition":
                     f"attachment; filename=performance_{req.period}.csv"})

    if fmt in ("xlsx", "excel"):
        summary = result["summary"]
        sheets = {
            f"Performance {req.period}": compare.to_csv_rows(rows),
            "Summary": [["metric", "value"]]
                       + [[k, v if not isinstance(v, dict) else
                           f"{v.get('symbol')} ({list(v.values())[1]})"]
                          for k, v in summary.items()],
        }
        if result.get("benchmark"):
            sheets["Benchmark"] = [["metric", "value"]] + [
                [k, v] for k, v in result["benchmark"].items()]
        try:
            body = exports.sheets_to_xlsx(sheets)
        except exports.XlsxUnavailable as e:
            raise HTTPException(501, str(e))
        return Response(
            content=body,
            media_type="application/vnd.openxmlformats-officedocument."
                       "spreadsheetml.sheet",
            headers={"Content-Disposition":
                     f"attachment; filename=performance_{req.period}.xlsx"})

    raise HTTPException(400, f"Unsupported format {fmt!r}. Use 'csv' or 'xlsx'.")


@app.post("/api/portfolio/export")
def portfolio_export(req: ExportRequest):
    """Download holdings as CSV (default) or XLSX.

    The XLSX carries three sheets — lots, per-symbol roll-up, and the summary —
    because a holdings file is something people keep and re-import later.
    """
    fmt = (req.format or "csv").lower()
    parsed = positions.parse_positions([p.model_dump() for p in req.positions])
    quotes = data.get_quotes(sorted({p.symbol for p in parsed})) if parsed else []
    result = positions.value_portfolio(parsed, quotes)
    rows = result["positions"]
    summary = result["summary"]

    if fmt == "csv":
        body = exports.rows_to_csv(positions.to_csv_rows(rows))
        return Response(
            content=body, media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=holdings.csv"})

    if fmt in ("xlsx", "excel"):
        by_symbol = positions.aggregate_lots(rows)
        sheets = {
            "Holdings": positions.to_csv_rows(rows),
            "By Symbol": exports.dicts_to_rows(
                by_symbol, ["symbol", "shares", "lots", "avg_cost", "cost",
                            "price", "market_value", "pnl", "pnl_pct", "day_pnl"]),
            "Summary": [["metric", "value"]]
                       + [[k, v if not isinstance(v, dict) else
                           f"{v.get('symbol')} ({list(v.values())[1]})"]
                          for k, v in summary.items()],
        }
        try:
            body = exports.sheets_to_xlsx(sheets)
        except exports.XlsxUnavailable as e:
            raise HTTPException(501, str(e))
        return Response(
            content=body,
            media_type="application/vnd.openxmlformats-officedocument."
                       "spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=holdings.xlsx"})

    raise HTTPException(400, f"Unsupported format {fmt!r}. Use 'csv' or 'xlsx'.")


@app.post("/api/portfolio/import")
async def portfolio_import(file: UploadFile = File(...)):
    """Parse an uploaded holdings CSV/XLSX back into positions.

    Header names are matched loosely (ticker/qty/avg cost/…) so a file exported
    straight from a broker imports without hand-editing.
    """
    content = await file.read()
    if len(content) > 2_000_000:
        raise HTTPException(413, "File too large (2 MB limit).")
    try:
        parsed = exports.parse_positions_file(file.filename or "", content)
    except exports.XlsxUnavailable as e:
        raise HTTPException(501, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"Could not read that file: {e}")
    if not parsed:
        raise HTTPException(
            422, "No usable rows found. Each row needs a ticker, a share count "
                 "and a cost per share.")
    return {"positions": parsed, "count": len(parsed)}


@app.get("/api/export.xlsx")
def export_xlsx(symbols: str, period: str = "6mo"):
    """Full analysis as a multi-sheet workbook: quotes, metrics, price history."""
    syms = _parse_symbols(symbols)
    result = _analyze(syms, period)
    analyses_by_sym = {a["symbol"]: a for a in result["analyses"]}

    quote_rows = [["symbol", "name", "price", "change", "change_pct", "pe",
                   "market_cap", "total_return_pct", "annualized_volatility_pct",
                   "max_drawdown_pct", "trend"]]
    for q in result["quotes"]:
        a = analyses_by_sym.get(q["symbol"], {})
        quote_rows.append([q["symbol"], q["name"], q["price"], q["change"],
                           q["change_pct"], q["pe"], q["market_cap"],
                           a.get("total_return_pct"),
                           a.get("annualized_volatility_pct"),
                           a.get("max_drawdown_pct"), a.get("trend")])

    sheets = {"Quotes": quote_rows}
    for sym, hist in result["histories"].items():
        sheets[f"{sym} prices"] = [["date", "close"]] + [
            [d, c] for d, c in zip(hist["dates"], hist["closes"])]

    try:
        body = exports.sheets_to_xlsx(sheets)
    except exports.XlsxUnavailable as e:
        raise HTTPException(501, str(e))
    return Response(
        content=body,
        media_type="application/vnd.openxmlformats-officedocument."
                   "spreadsheetml.sheet",
        headers={"Content-Disposition":
                 f"attachment; filename=stock_analysis_{period}.xlsx"})


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    if not req.symbols:
        raise HTTPException(400, "No symbols provided")
    return _analyze([s.upper() for s in req.symbols], req.period)


@app.post("/api/chat")
def chat(req: ChatRequest):
    mode = (req.mode or "standard").lower()
    context: dict = {}

    if req.symbols:
        full = _analyze([s.upper() for s in req.symbols], req.period)
        # Don't ship the full price series to the LLM — just quotes + stats.
        context = {"quotes": full["quotes"],
                   "analyses": full["analyses"],
                   "summary": full["summary"]}

        focus = req.symbols[0].upper()
        # Give the analyst the same derived numbers the user is looking at, so
        # it can't contradict the panels on screen.
        try:
            c = data.get_candles(focus, "1y", "1d")
            if c.close:
                f = forecast.forecast(focus, c.dates, c.open, c.high, c.low,
                                      c.close, c.volume)
                context["forecast"] = {k: f[k] for k in
                                       ("symbol", "signal", "trend", "risk", "levels")}
                context["forecast"]["bands"] = f.get("bands", {}).get("bands", {})
        except Exception:  # noqa: BLE001 — chat still works without the forecast
            pass

        try:
            fund = data.get_holdings(focus)
            if fund.get("is_fund"):
                context["fund_composition"] = {
                    "symbol": fund["symbol"], "name": fund.get("name"),
                    "top_holdings": fund.get("holdings", [])[:10],
                    "sectors": fund.get("sectors", [])[:6],
                    "expense_ratio_pct": fund.get("expense_ratio_pct"),
                }
        except Exception:  # noqa: BLE001
            pass

        if mode == "daytrader":
            try:
                intraday = data.get_candles(focus, "1d", "5m").to_dict()
                daily = data.get_candles(focus, "3mo", "1d").to_dict()
                context["intraday"] = daytrade.daytrade_levels(focus, intraday, daily)
            except Exception:  # noqa: BLE001
                pass

    if req.positions:
        try:
            parsed = positions.parse_positions([p.model_dump() for p in req.positions])
            if parsed:
                pq = data.get_quotes(sorted({p.symbol for p in parsed}))
                valued = positions.value_portfolio(parsed, pq)
                context["positions"] = {
                    "holdings": positions.aggregate_lots(valued["positions"]),
                    "summary": valued["summary"],
                }
        except Exception:  # noqa: BLE001
            pass

    try:
        return ai.chat([m.model_dump() for m in req.messages],
                       data_context=context or None, mode=mode)
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
