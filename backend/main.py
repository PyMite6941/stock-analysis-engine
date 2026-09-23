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
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from core import (assets, backtest, compare, correlation, data, daytrade,
                  events, forecast, income, indicators, metrics, positions,
                  realized, risk, tax)
from backend import ai, exports, vision
from backend.middleware import SecurityAndAuthMiddleware, logger

app = FastAPI(title="Stock Analysis Engine", version="0.1.0")

# CORS. On the web the app is same-origin and none of this applies; it exists
# for the dev server and for the packaged apps, which are genuinely
# cross-origin:
#
#   capacitor://localhost   iOS shell
#   http://localhost        Android shell (and its dev server)
#   file://                 Electron, which sends Origin: null
#
# Auth travels in a header rather than a cookie, so credentials are not allowed
# and these origins cannot be used to ride on someone's session.
_APP_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",   # vite dev
    "http://localhost:4173", "http://127.0.0.1:4173",   # vite preview
    "capacitor://localhost", "ionic://localhost",        # iOS shell
    "http://localhost",                                  # Android shell
    "null",                                              # Electron file://
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_APP_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    # The stale-data banner reads these, and a cross-origin response hides
    # every header unless it is explicitly exposed.
    expose_headers=["x-sae-offline", "x-sae-cached-at", "Content-Disposition"],
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
    exit_plan: Optional[str] = None
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


class SaleIn(BaseModel):
    symbol: str
    shares: float
    cost_basis: float
    exit_price: float
    # Both accept "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" — the clock time matters
    # for intraday round trips, where the holding period is minutes.
    opened: Optional[str] = None
    closed: Optional[str] = None
    note: Optional[str] = None
    id: Optional[str] = None


class SellRequest(BaseModel):
    positions: list[PositionIn] = []
    symbol: str
    shares: float
    price: float
    sold_on: Optional[str] = None
    method: str = "fifo"          # fifo | lifo | specific
    lot_ids: list[str] = []


class RealizedRequest(BaseModel):
    sales: list[SaleIn] = []
    positions: list[PositionIn] = []
    year: Optional[int] = None
    format: str = "csv"


class PortfolioAnalysisRequest(BaseModel):
    positions: list[PositionIn] = []
    period: str = "1y"


class TaxRequest(BaseModel):
    """Form 8949 / Schedule D for one tax year.

    `basis_reported` decides which 8949 box each row lands in. We cannot know
    it — only the 1099-B says — so it is the caller's to set: true for a
    covered security (the common case), false when a 1099-B came without basis,
    null when there is no 1099-B at all.
    """
    sales: list[SaleIn] = []
    positions: list[PositionIn] = []
    year: Optional[int] = None
    basis_reported: Optional[bool] = True
    format: str = "csv"


class EventsRequest(BaseModel):
    """Upcoming dated events for a set of symbols."""
    symbols: list[str] = []
    positions: list[PositionIn] = []
    within_days: int = 90


class ExportAllRequest(BaseModel):
    """Everything the user has, in one workbook."""
    symbols: list[str] = []
    positions: list[PositionIn] = []
    sales: list[SaleIn] = []
    period: str = "6mo"
    benchmark: Optional[str] = "SPY"


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
    """Status, and which provider is ACTUALLY serving data.

    Reporting the raw DATA_PROVIDER env var here used to be a lie whenever the
    value was unset or unusable — the point of this endpoint is to tell you what
    is really running, so it resolves the same way the request path does. Still
    never instantiates the provider, so a missing key can't 500 the healthcheck.
    """
    import os
    configured = os.environ.get("DATA_PROVIDER", "").strip().lower() or None
    resolved = data.choose_provider_name()
    return {
        "status": "ok",
        "data_provider": resolved,
        # Explicit config vs auto-selected, so a surprising value is traceable.
        "data_provider_configured": configured,
        "data_provider_source": "env" if configured else "auto",
        "finnhub_key": bool(os.environ.get("FINNHUB_API_KEY")),
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


@app.get("/api/search")
def search(q: str, limit: int = 8):
    """Find a ticker from a company name — "nvidia" -> NVDA.

    Not knowing the ticker is a dead end for a beginner, since the ticker is
    exactly what they were trying to find out.
    """
    return {"query": q, "results": data.search_symbols(q, limit=limit)}


@app.get("/api/asset")
def asset_info(symbol: str):
    """What kind of instrument this is, and what the UI should therefore show.

    Lets panels ask "does this have intraday data / a P/E / volume" instead of
    each one re-deriving it, and keeps a mutual fund from being offered a
    day-trading view it cannot support.
    """
    data.require_symbol(symbol)
    return data.describe_asset(symbol)


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
    info = data.describe_asset(symbol)
    if not info["day_tradeable"]:
        # A mutual fund has no intraday session at all. Say so instead of
        # computing a VWAP from the single daily NAV print.
        return daytrade.daytrade_levels(symbol, {}, {}, info["asset_class"])
    # 5 days rather than 1 so that pre-market (and Monday morning) can still fall
    # back to the last completed session instead of a handful of overnight prints.
    intraday = data.get_candles(symbol, "5d", interval).to_dict()
    daily = data.get_candles(symbol, "3mo", "1d").to_dict()
    out = daytrade.daytrade_levels(symbol, intraday, daily, info["asset_class"])
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


@app.get("/api/backtest")
def backtest_endpoint(symbol: str, period: str = "5y", horizon: int = 21):
    """Did the signal score actually predict anything on this symbol?

    Scores every historical bar point-in-time, then measures the forward return.
    Reports the verdict honestly, including "no-edge" and "inverted".
    """
    data.require_symbol(symbol)
    c = data.get_candles(symbol, period, "1d")
    if not c.close:
        raise HTTPException(422, f"No price history for {symbol.upper()}.")
    out = backtest.backtest_signal(c.close, c.volume, horizon=horizon)
    out["symbol"] = symbol.upper()
    out["period"] = period
    out["summary"] = backtest.backtest_summary(out)
    return out


@app.post("/api/portfolio/income")
def portfolio_income(req: PortfolioAnalysisRequest):
    """Dividend income: annual/monthly projection, yield on cost, ex-div dates."""
    parsed = positions.parse_positions([p.model_dump() for p in req.positions])
    if not parsed:
        raise HTTPException(422, "No valid positions.")

    symbols = sorted({p.symbol for p in parsed})
    quotes = data.get_quotes(symbols)
    known = [q.symbol for q in quotes if not q.not_found]
    if not known:
        raise data.SymbolNotFound(", ".join(symbols))

    def income_for(sym):
        try:
            return sym, (data.get_insights(sym) or {}).get("income", {}) or {}
        except Exception:  # noqa: BLE001 - a missing block just means no dividend
            return sym, {}

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(known)))) as ex:
        income_map = dict(ex.map(income_for, known))

    held = [p for p in parsed if p.symbol in known]
    out = income.portfolio_income(held, quotes, income_map)
    out["not_found"] = [q.symbol for q in quotes if q.not_found]
    return out


@app.post("/api/portfolio/correlation")
def portfolio_correlation(req: PortfolioAnalysisRequest):
    """Correlation matrix + how many independent bets the book really is."""
    parsed = positions.parse_positions([p.model_dump() for p in req.positions])
    symbols = sorted({p.symbol for p in parsed})
    if len(symbols) < 2:
        return {"available": False,
                "reason": "Correlation needs at least two different holdings."}

    quotes = data.get_quotes(symbols)
    known = [q.symbol for q in quotes if not q.not_found]
    if len(known) < 2:
        return {"available": False,
                "reason": "Fewer than two holdings could be priced."}

    with ThreadPoolExecutor(max_workers=min(8, len(known))) as ex:
        hists = list(ex.map(lambda s: data.get_history(s, req.period), known))
    histories = {h.symbol: h.to_dict() for h in hists}

    # Weight by market value so the diversification maths reflects real sizing.
    valued = positions.value_portfolio(
        [p for p in parsed if p.symbol in known], quotes)
    weights = {}
    for row in valued["positions"]:
        weights[row["symbol"]] = weights.get(row["symbol"], 0) + (row["market_value"] or 0)

    corr = correlation.correlation_matrix(histories)
    div = correlation.diversification(histories, weights)
    return {"correlation": corr, "diversification": div,
            "verdict": correlation.verdict(corr, div), "period": req.period,
            "not_found": [q.symbol for q in quotes if q.not_found]}


@app.post("/api/portfolio/forecast")
def portfolio_forecast_endpoint(req: PortfolioAnalysisRequest):
    """Probability cone for the whole book, with correlations already baked in."""
    parsed = positions.parse_positions([p.model_dump() for p in req.positions])
    if not parsed:
        raise HTTPException(422, "No valid positions.")

    symbols = sorted({p.symbol for p in parsed})
    quotes = data.get_quotes(symbols)
    known = [q.symbol for q in quotes if not q.not_found]
    if not known:
        raise data.SymbolNotFound(", ".join(symbols))

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(known)))) as ex:
        hists = list(ex.map(lambda s: data.get_history(s, req.period), known))
    histories = {h.symbol: h.to_dict() for h in hists}

    shares: dict[str, float] = {}
    for p in parsed:
        if p.symbol in known:
            shares[p.symbol] = shares.get(p.symbol, 0.0) + p.shares

    out = forecast.portfolio_forecast(histories, shares)
    out["period"] = req.period
    out["not_found"] = [q.symbol for q in quotes if q.not_found]
    return out


@app.post("/api/portfolio/sell")
def portfolio_sell(req: SellRequest):
    """Match a sale against open lots and return the realised rows.

    Stateless: the client sends its lots, gets back the realised gains plus the
    updated lot list, and persists both. The server never stores holdings.
    """
    lots = positions.parse_positions([p.model_dump() for p in req.positions])
    result = realized.match_sale(
        lots, req.symbol, req.shares, req.price, req.sold_on,
        (req.method or "fifo").lower(), req.lot_ids or None)
    if result.get("error"):
        raise HTTPException(422, result["error"])
    if not result["realized"]:
        raise HTTPException(
            422, f"No open lots of {req.symbol.upper()} to sell against.")
    return {
        "realized": result["realized"],
        "remaining_lots": [l.to_dict() for l in result["remaining_lots"]],
        "unmatched": result["unmatched"],
        "proceeds": round(req.shares * req.price, 2),
    }


@app.post("/api/portfolio/realized")
def portfolio_realized(req: RealizedRequest):
    """Realised gains: totals, short vs long term, per-year, and lots nearing
    long-term treatment."""
    sales = realized.parse_sales([s.model_dump() for s in req.sales])
    lots = positions.parse_positions([p.model_dump() for p in req.positions])
    return {
        "sales": sales,
        "summary": realized.realized_summary(sales, req.year),
        "by_year": realized.realized_by_year(sales),
        "approaching_long_term": realized.lots_approaching_long_term(lots),
    }


@app.post("/api/portfolio/realized/export")
def portfolio_realized_export(req: RealizedRequest):
    """Realised gains as CSV (default) or a multi-sheet XLSX."""
    sales = realized.parse_sales([s.model_dump() for s in req.sales])
    if not sales:
        raise HTTPException(422, "No sales to export.")
    fmt = (req.format or "csv").lower()

    if fmt == "csv":
        return Response(
            content=exports.rows_to_csv(realized.to_csv_rows(sales)),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=realized_gains.csv"})

    if fmt in ("xlsx", "excel"):
        summary = realized.realized_summary(sales, req.year)
        sheets = {
            "Realized Gains": realized.to_csv_rows(sales),
            "Summary": [["metric", "value"]]
                       + [[k, v if not isinstance(v, dict) else
                           f"{v.get('symbol')} ({v.get('pnl')})"]
                          for k, v in summary.items()],
        }
        by_year = realized.realized_by_year(sales)
        if by_year:
            sheets["By Year"] = [
                ["year", "n_sales", "total_pnl", "short_term_pnl",
                 "long_term_pnl", "win_rate_pct"]
            ] + [[y["year"], y["n_sales"], y["total_pnl"], y["short_term_pnl"],
                  y["long_term_pnl"], y["win_rate_pct"]] for y in by_year]
        try:
            body = exports.sheets_to_xlsx(sheets)
        except exports.XlsxUnavailable as e:
            raise HTTPException(501, str(e))
        return Response(
            content=body,
            media_type="application/vnd.openxmlformats-officedocument."
                       "spreadsheetml.sheet",
            headers={"Content-Disposition":
                     "attachment; filename=realized_gains.xlsx"})

    raise HTTPException(400, f"Unsupported format {fmt!r}. Use 'csv' or 'xlsx'.")


@app.post("/api/portfolio/tax")
def portfolio_tax(req: TaxRequest):
    """Form 8949 rows, Schedule D subtotals, and the wash sales behind them.

    Stateless like every other portfolio route: the client sends what it has
    stored and gets the worksheet back. Nothing is retained here.
    """
    sales = realized.parse_sales([s.model_dump() for s in req.sales])
    lots = positions.parse_positions([p.model_dump() for p in req.positions])
    form = tax.form_8949_rows(sales, lots, req.year, req.basis_reported)
    return {
        "form_8949": form["rows"],
        "schedule_d": tax.schedule_d(form["rows"]),
        "year": req.year,
        "basis_reported": req.basis_reported,
        "n_wash": form["n_wash"],
        "total_disallowed": form["total_disallowed"],
        "crypto_exempt": form["crypto_exempt"],
        "years_available": sorted(
            {str(s.get("closed") or "")[:4] for s in sales
             if str(s.get("closed") or "")[:4].isdigit()}, reverse=True),
    }


@app.post("/api/portfolio/tax/export")
def portfolio_tax_export(req: TaxRequest):
    """The tax worksheet as CSV (8949 only) or XLSX (8949 + D + wash sales)."""
    sales = realized.parse_sales([s.model_dump() for s in req.sales])
    if not sales:
        raise HTTPException(422, "No sales to report.")
    lots = positions.parse_positions([p.model_dump() for p in req.positions])
    form = tax.form_8949_rows(sales, lots, req.year, req.basis_reported)
    if not form["rows"]:
        raise HTTPException(
            422, f"No sales closed in {req.year}." if req.year
            else "No sales to report.")

    year = req.year or "all"
    fmt = (req.format or "csv").lower()

    if fmt == "csv":
        return Response(
            content=exports.rows_to_csv(tax.to_csv_rows(form["rows"])),
            media_type="text/csv",
            headers={"Content-Disposition":
                     f"attachment; filename=form_8949_{year}.csv"})

    if fmt in ("xlsx", "excel"):
        d = tax.schedule_d(form["rows"])
        sheets = {
            "Form 8949": tax.to_csv_rows(form["rows"]),
            "Schedule D": (
                [["Box", "Term", "Rows", "Proceeds", "Cost basis",
                  "Adjustment", "Gain or (loss)"]]
                + [[l["box"], l["term"], l["n_rows"], l["proceeds"],
                    l["cost_basis"], l["adjustment"], l["gain_loss"]]
                   for l in d["lines"]]
                + [[]]
                + [["Short-term net", "", "", d["short_term"]["proceeds"],
                    d["short_term"]["cost_basis"],
                    d["short_term"]["adjustment"], d["short_term"]["net"]],
                   ["Long-term net", "", "", d["long_term"]["proceeds"],
                    d["long_term"]["cost_basis"],
                    d["long_term"]["adjustment"], d["long_term"]["net"]],
                   ["Net gain or (loss)", "", "", "", "", "",
                    d["net_gain_loss"]]]
                + ([["Deductible this year (capped at $3,000)", "", "", "", "",
                     "", d["deductible_loss"]],
                    ["Carried forward", "", "", "", "", "",
                     d["loss_carryforward"] or 0]]
                   if d["deductible_loss"] is not None else [])),
            "Wash Sales": tax.wash_csv_rows(form["rows"]),
        }
        try:
            body = exports.sheets_to_xlsx(sheets)
        except exports.XlsxUnavailable as e:
            raise HTTPException(501, str(e))
        return Response(
            content=body,
            media_type="application/vnd.openxmlformats-officedocument."
                       "spreadsheetml.sheet",
            headers={"Content-Disposition":
                     f"attachment; filename=form_8949_{year}.xlsx"})

    raise HTTPException(400, f"Unsupported format {fmt!r}. Use 'csv' or 'xlsx'.")


@app.post("/api/portfolio/events")
def portfolio_events(req: EventsRequest):
    """Dated events ahead for the symbols you hold: earnings and ex-dividends.

    The forecast cone has no idea an earnings report is coming, which is the
    single most common reason a stock gaps overnight. This is the missing
    context, not a prediction.
    """
    symbols = events.symbols_from(
        req.symbols, [p.model_dump() for p in req.positions])
    if not symbols:
        return {"events": [], "by_symbol": {}, "n": 0, "within_days": req.within_days}

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(symbols)))) as ex:
        fundamentals = dict(zip(
            symbols, ex.map(_safe_fundamentals, symbols)))

    cal = events.build_calendar(fundamentals, within_days=req.within_days)
    return {**cal, "symbols": symbols}


def _safe_fundamentals(symbol: str):
    """Fundamentals for one symbol, or None — one bad ticker can't kill a page."""
    try:
        return data.get_fundamentals(symbol)
    except Exception as e:          # noqa: BLE001 - any provider failure
        logger.warning("fundamentals failed for %s: %s", symbol, e)
        return None


@app.post("/api/portfolio/risk")
def portfolio_risk(req: PortfolioAnalysisRequest):
    """Portfolio-level risk: concentration, correlation clusters, drawdown.

    Per-symbol Sharpe and VaR are already elsewhere. This is the roll-up — the
    numbers that describe the book as one thing, which is what actually decides
    what to buy next.
    """
    lots = positions.parse_positions([p.model_dump() for p in req.positions])
    if not lots:
        raise HTTPException(422, "No positions to analyse.")

    symbols = sorted({l.symbol for l in lots})
    quotes = data.get_quotes(symbols)
    priced = [q for q in quotes if not q.not_found and q.price is not None]
    if not priced:
        raise HTTPException(422, "No prices available for these positions.")

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(symbols)))) as ex:
        hist = dict(zip(symbols, ex.map(
            lambda s: _safe_history(s, req.period), symbols)))
    histories = {s: {"dates": h.dates, "closes": h.closes}
                 for s, h in hist.items() if h and len(h.closes) > 1}

    valued = positions.value_portfolio(lots, quotes)
    return risk.portfolio_risk(valued, histories, period=req.period)


def _safe_history(symbol: str, period: str):
    try:
        return data.get_history(symbol, period)
    except Exception as e:          # noqa: BLE001
        logger.warning("history failed for %s: %s", symbol, e)
        return None


@app.post("/api/export/all")
def export_all(req: ExportAllRequest):
    """One click, one file: every sheet the user could want.

    Exporting piecemeal means remembering which button produced which file and
    stitching them together later. A single workbook with a sheet per view is
    what someone actually wants when they say "export my data", so this is the
    default the UI offers and the per-panel buttons become the exception.

    Every section is optional and skipped silently when there's nothing to put
    in it — an empty portfolio shouldn't produce an empty-sheet error.
    """
    sheets: dict[str, list[list]] = {}
    notes = [["section", "status"]]

    parsed = positions.parse_positions([p.model_dump() for p in req.positions])
    sold = realized.parse_sales([s.model_dump() for s in req.sales])

    # Quote every symbol the user cares about in ONE call: watchlist + holdings.
    wanted = sorted({s.strip().upper() for s in req.symbols if s.strip()}
                    | {p.symbol for p in parsed})
    quotes = data.get_quotes(wanted) if wanted else []
    known = [q.symbol for q in quotes if not q.not_found]

    # --- watchlist analysis -------------------------------------------------
    watch = [s.strip().upper() for s in req.symbols if s.strip()]
    watch = [s for s in watch if s in known]
    if watch:
        try:
            result = _analyze(watch, req.period)
            by_sym = {a["symbol"]: a for a in result["analyses"]}
            rows = [["symbol", "name", "price", "change", "change_pct", "pe",
                     "market_cap", "total_return_pct", "annualized_volatility_pct",
                     "max_drawdown_pct", "trend"]]
            for q in result["quotes"]:
                a = by_sym.get(q["symbol"], {})
                rows.append([q["symbol"], q["name"], q["price"], q["change"],
                             q["change_pct"], q["pe"], q["market_cap"],
                             a.get("total_return_pct"),
                             a.get("annualized_volatility_pct"),
                             a.get("max_drawdown_pct"), a.get("trend")])
            sheets["Watchlist"] = rows
            for sym, hist in result["histories"].items():
                sheets[f"{sym} prices"] = [["date", "close"]] + [
                    [d, c] for d, c in zip(hist["dates"], hist["closes"])]
            notes.append(["Watchlist", f"{len(watch)} symbols over {req.period}"])
        except Exception as e:  # noqa: BLE001 — one bad section shouldn't kill the file
            notes.append(["Watchlist", f"skipped: {e}"])

    # --- holdings -----------------------------------------------------------
    if parsed:
        try:
            valued = positions.value_portfolio(parsed, quotes)
            sheets["Holdings"] = positions.to_csv_rows(valued["positions"])
            sheets["By Symbol"] = exports.dicts_to_rows(
                positions.aggregate_lots(valued["positions"]),
                ["symbol", "shares", "lots", "avg_cost", "cost", "price",
                 "market_value", "pnl", "pnl_pct", "day_pnl"])
            sheets["Portfolio Summary"] = [["metric", "value"]] + [
                [k, v if not isinstance(v, dict) else
                 f"{v.get('symbol')} ({list(v.values())[1]})"]
                for k, v in valued["summary"].items()]
            notes.append(["Holdings", f"{len(parsed)} lot" + ("s" if len(parsed) != 1 else "")])
        except Exception as e:  # noqa: BLE001
            notes.append(["Holdings", f"skipped: {e}"])

        # --- performance over the period ------------------------------------
        try:
            held = [p for p in parsed if p.symbol in known]
            if held:
                syms = sorted({p.symbol for p in held})
                with ThreadPoolExecutor(max_workers=min(8, len(syms))) as ex:
                    hists = list(ex.map(
                        lambda s: data.get_history(s, req.period), syms))
                histories = {h.symbol: h.to_dict() for h in hists}
                bench = None
                if req.benchmark:
                    try:
                        b = data.get_history(req.benchmark, req.period)
                        bench = {"symbol": b.symbol, "dates": b.dates,
                                 "closes": b.closes}
                    except Exception:  # noqa: BLE001
                        bench = None
                cmp_out = compare.compare_positions(
                    held, histories, quotes, req.period, bench)
                sheets[f"Performance {req.period}"] = compare.to_csv_rows(
                    cmp_out["positions"])
                if cmp_out.get("benchmark"):
                    sheets["Benchmark"] = [["metric", "value"]] + [
                        [k, v] for k, v in cmp_out["benchmark"].items()]
                notes.append([f"Performance {req.period}", "included"])
        except Exception as e:  # noqa: BLE001
            notes.append(["Performance", f"skipped: {e}"])

        # --- dividend income -------------------------------------------------
        try:
            def income_for(sym):
                try:
                    return sym, (data.get_insights(sym) or {}).get("income", {}) or {}
                except Exception:  # noqa: BLE001
                    return sym, {}

            held = [p for p in parsed if p.symbol in known]
            if held:
                syms = sorted({p.symbol for p in held})
                with ThreadPoolExecutor(max_workers=min(8, len(syms))) as ex:
                    income_map = dict(ex.map(income_for, syms))
                inc = income.portfolio_income(held, quotes, income_map)
                if any(r.get("annual_income") for r in inc["positions"]):
                    sheets["Dividend Income"] = income.to_csv_rows(inc["positions"])
                    notes.append(["Dividend Income", "included"])
        except Exception as e:  # noqa: BLE001
            notes.append(["Dividend Income", f"skipped: {e}"])

    # --- realised gains -----------------------------------------------------
    if sold:
        try:
            sheets["Realized Gains"] = realized.to_csv_rows(sold)
            summary = realized.realized_summary(sold)
            sheets["Realized Summary"] = [["metric", "value"]] + [
                [k, v if not isinstance(v, dict) else
                 f"{v.get('symbol')} ({v.get('pnl')})"]
                for k, v in summary.items()]
            by_year = realized.realized_by_year(sold)
            if by_year:
                sheets["Realized By Year"] = [
                    ["year", "n_sales", "total_pnl", "short_term_pnl",
                     "long_term_pnl", "win_rate_pct"]
                ] + [[y["year"], y["n_sales"], y["total_pnl"], y["short_term_pnl"],
                      y["long_term_pnl"], y["win_rate_pct"]] for y in by_year]
            notes.append(["Realized Gains", f"{len(sold)} closed trade" + ("s" if len(sold) != 1 else "")])
        except Exception as e:  # noqa: BLE001
            notes.append(["Realized Gains", f"skipped: {e}"])

        # Tax worksheet for the CURRENT year only. "Everything" here means
        # everything you'd hand to someone; a single 8949 covering six years at
        # once is not a form anyone can file.
        try:
            lots = positions.parse_positions([p.model_dump() for p in req.positions])
            year = datetime.now().year
            form = tax.form_8949_rows(sold, lots, year)
            if form["rows"]:
                sheets[f"Form 8949 ({year})"] = tax.to_csv_rows(form["rows"])
                d = tax.schedule_d(form["rows"])
                sheets["Schedule D"] = (
                    [["Box", "Term", "Rows", "Proceeds", "Cost basis",
                      "Adjustment", "Gain or (loss)"]]
                    + [[l["box"], l["term"], l["n_rows"], l["proceeds"],
                        l["cost_basis"], l["adjustment"], l["gain_loss"]]
                       for l in d["lines"]]
                    + [[], ["Net gain or (loss)", "", "", "", "", "",
                            d["net_gain_loss"]]])
                if form["n_wash"]:
                    sheets["Wash Sales"] = tax.wash_csv_rows(form["rows"])
                notes.append([f"Form 8949 ({year})",
                              f"{len(form['rows'])} rows, "
                              f"{form['n_wash']} wash sale(s)"])
        except Exception as e:  # noqa: BLE001
            notes.append(["Form 8949", f"skipped: {e}"])

    if not sheets:
        raise HTTPException(
            422, "Nothing to export yet — add a symbol or a position first.")

    unknown = [q.symbol for q in quotes if q.not_found]
    if unknown:
        notes.append(["Not found", ", ".join(unknown)])
    notes.append(["Exported", datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")])
    sheets["About"] = notes

    try:
        body = exports.sheets_to_xlsx(sheets)
    except exports.XlsxUnavailable as e:
        raise HTTPException(501, str(e))
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    return Response(
        content=body,
        media_type="application/vnd.openxmlformats-officedocument."
                   "spreadsheetml.sheet",
        headers={"Content-Disposition":
                 f"attachment; filename=stock-analysis-{stamp}.xlsx"})


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


@app.post("/api/import/photo")
async def import_photo(file: UploadFile = File(...),
                       hint: Optional[str] = None):
    """Read a screenshot of transaction history into candidate rows.

    Returns rows for REVIEW — it deliberately saves nothing. OCR misreads
    decimals and will produce a plausible wrong number for a smudged cell, so
    every row comes back with a confidence and the client requires an explicit
    confirmation before any of it reaches the portfolio.
    """
    content = await file.read()
    if not content:
        raise HTTPException(422, "That file was empty.")
    try:
        out = vision.read_transactions(
            content, file.content_type or "image/png", hint)
    except vision.NoVisionProvider as e:
        raise HTTPException(503, str(e))
    except vision.RateLimited as e:
        # 429 rather than 502: nothing is broken, the caller just needs to wait,
        # and the UI can say so instead of implying the feature is faulty.
        headers = ({"Retry-After": str(int(e.retry_after))}
                   if e.retry_after else None)
        raise HTTPException(429, str(e), headers=headers)
    except vision.ImageTooLarge as e:
        raise HTTPException(413, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Could not read that image: {e}")
    out["filename"] = file.filename
    return out


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
