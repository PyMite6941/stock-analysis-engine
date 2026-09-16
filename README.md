# Stock Analysis Engine

Live stock data → computed metrics → AI analyst you can chat with. Plus a fully
offline analysis mode that uses none of the AI.

## Architecture

```
core/        Shared Python: data fetching (pluggable API) + analysis math. NO AI.
backend/     FastAPI: serves data, CSV download, and the AI chat proxy.
frontend/    React + Vite: tables, charts, AI chat panel, download button.
offline/     Streamlit: offline analysis reusing core/. NO AI, no keys needed.
```

`core/` is the single source of truth for numbers, so the **offline Streamlit
math is identical to the online backend math**. The AI lives only in `backend/`
(`ai.py`) and `frontend/` — the offline path never imports it.

## Data + AI providers

| Concern | Provider | Notes |
|---|---|---|
| Stock data | `yfinance` (default, no key) or `finnhub` (REST key) | set `DATA_PROVIDER` |
| AI analysis/chat | **Groq** → **OpenRouter** fallback chain | both OpenAI-compatible; keys server-side only |

Copy `.env.example` → `.env` and fill in keys. Offline mode needs no keys when
`DATA_PROVIDER=yfinance`.

## Run it

All Python commands run **from this project root** so `core` imports cleanly.

### 1. Backend (online API + AI)
```bash
python -m venv .venv && . .venv/Scripts/activate   # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
# create .env from .env.example, add GROQ_API_KEY and/or OPENROUTER_API_KEY
uvicorn backend.main:app --reload --port 8000
```

### 2. Frontend (React + Vite)
```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 ; /api proxied to :8000
```

### 3. Offline analysis (Streamlit, no AI)
```bash
pip install -r offline/requirements.txt
streamlit run offline/app.py
```

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/health` | status + active data provider |
| GET  | `/api/quotes?symbols=AAPL,MSFT` | live quotes |
| GET  | `/api/history?symbol=AAPL&period=6mo` | price series |
| GET  | `/api/forecast?symbol=AAPL&period=1y[&target=]` | projections, probability cone, signal score, risk, S/R |
| GET  | `/api/daytrade?symbol=AAPL` | VWAP, opening range, pivots, ATR, position sizing |
| GET  | `/api/holdings?symbol=SPY` | ETF / index-fund composition |
| POST | `/api/analyze` | quotes + per-symbol metrics + summary |
| POST | `/api/chat` | AI analyst grounded in current data (`mode`, `positions`) |
| POST | `/api/portfolio` | mark holdings to market: cost, value, P/L, weights |
| POST | `/api/portfolio/compare` | gain/loss over a period + benchmark |
| POST | `/api/portfolio/export` | holdings as CSV (default) or XLSX |
| POST | `/api/portfolio/compare/export` | period comparison as CSV or XLSX |
| POST | `/api/portfolio/import` | parse an uploaded holdings CSV/XLSX |
| GET  | `/api/download.csv?symbols=...&period=6mo` | CSV export |
| GET  | `/api/export.xlsx?symbols=...&period=6mo` | multi-sheet workbook |

A ticker that doesn't exist returns **404** with
`{"error": "symbol_not_found", "detail": "Stock/ETF not found: XYZ..."}` rather
than a generic failure, so the UI can say so plainly.

## Modes

The dashboard has three modes (persisted in localStorage), which change which
panels render *and* how the AI analyst writes:

| Mode | For | Changes |
|---|---|---|
| 🎓 **Beginner** | never bought a stock | plain-English brief, glossary tooltips on every term of art, valuation/intraday panels hidden, AI defines jargon as it goes |
| 📊 **Standard** | the full research dashboard | everything except intraday |
| ⚡ **Day Trader** | intraday | VWAP/opening range/pivots/ATR, position sizer, live P/L on open positions, terse AI focused on levels and invalidation |

## Positions & spreadsheets

Record what you bought (`400 NVDA at $178.50`) and the app tracks cost, current
value, unrealised P/L, day P/L, weight and concentration. The list lives in
**localStorage only** — no account, no upload, and no cookies anywhere in the
app. Export to **CSV (default) or XLSX** and import it back; import matches
broker header spellings (`Ticker`/`Qty`/`Average Cost`/…) so a file exported from
a brokerage loads without hand-editing.

`/api/portfolio/compare` answers "did these gain or lose over the last N months",
and deliberately separates two numbers people conflate:

- **period return** — what the stock did over the window, regardless of when you bought
- **since-purchase return** — what *you* made, from your cost basis

These regularly disagree in sign. A lot opened partway through the window is
measured from its purchase date and flagged, not credited with the whole move.

## Deploy (Vercel)

One Vercel project serves both: the Vite frontend is built to static assets and
the FastAPI backend runs as a `@vercel/python` serverless function (`api/index.py`
re-exports `backend.main:app`; `vercel.json` rewrites `/api/*` to it). The
frontend calls relative `/api/...`, so it's same-origin in production — no CORS.

```bash
npm i -g vercel        # if needed
vercel                 # link/create the project (first run)
vercel --prod          # production deploy
```

Set these in the Vercel project's **Environment Variables**:

| Var | Value |
|---|---|
| `DATA_PROVIDER` | `finnhub` — yfinance is unreliable from cloud IPs |
| `FINNHUB_API_KEY` | your Finnhub key |
| `GROQ_API_KEY` and/or `OPENROUTER_API_KEY` | for the AI analyst |

> The offline Streamlit app is a **local-only** tool — Streamlit needs a
> persistent server and is not deployed to Vercel.

## Notes
- Not financial advice — the AI explains tradeoffs, it doesn't give buy/sell calls.
- To add a data provider: implement `quotes()` + `history()` in `core/data.py` and
  register it in `_PROVIDERS`.
- To add an AI provider: append to `_PROVIDERS` in `backend/ai.py` (any
  OpenAI-compatible `/chat/completions` endpoint works).
