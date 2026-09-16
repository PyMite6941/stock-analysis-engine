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
| GET  | `/api/backtest?symbol=AAPL&horizon=21` | did the signal score ever predict anything? |
| POST | `/api/portfolio/income` | dividend projection, yield on cost, ex-div dates |
| POST | `/api/portfolio/correlation` | correlation matrix + effective number of bets |
| POST | `/api/portfolio/forecast` | probability cone for the whole book |
| POST | `/api/portfolio/sell` | match a sale against open lots (FIFO/LIFO/specific) |
| POST | `/api/portfolio/realized` | realised gains, short vs long term, per year |
| POST | `/api/portfolio/realized/export` | realised gains as CSV or XLSX |

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

## Buying and selling

A position records a ticker, share count, price paid and — optionally — **when**,
as a date or a date and clock time (`2026-09-16 09:45`). The time matters for
intraday trades: buy and sell inside one session and the holding period is
measured in minutes, not days, and the trade is tagged as a day trade.

Selling matches against specific lots, which is where the real accounting lives:

| Method | Picks |
|---|---|
| **FIFO** (default) | oldest lots first — what brokers assume if you don't say otherwise |
| **LIFO** | newest lots first |
| **Specific** | lots you name, the only way to deliberately harvest a loss |

Realised gains are split into **short-term** and **long-term** (over one year),
because that split drives the tax bill, and open lots within 45 days of crossing
into long-term treatment get a countdown. A personal record, not a tax document —
your broker's 1099 is the authority and may apply wash-sale rules this does not.

## Does the signal actually work?

`/api/backtest` scores every historical bar **point-in-time** — only data
available on that day feeds the score — then measures the forward return, buckets
the results by score band, and reports one of: `predictive`, `weak-signal`,
`no-edge`, `inverted`, `insufficient-data`.

It reports the bad answers just as prominently as the good ones. On several large
caps the honest verdict is `no-edge` or `inverted`, and the UI says so. Two
guards keep it honest:

- **No lookahead.** Every indicator is a causal rolling series, verified by a test
  that scores bar *i* from the full series and again from a series truncated at
  *i*, and requires identical results.
- **Overlapping windows.** Consecutive days share most of their forward window, so
  the raw bar count massively overstates the evidence. `independent_samples`
  (n ÷ horizon) is what's reported, and thin samples are labelled unreliable.

## Diversification

`/api/portfolio/correlation` returns the pairwise correlation matrix plus
`effective_bets` — how many genuinely independent positions the book behaves
like. It separates the two causes of a concentrated book, because they need
different fixes:

- **concentration** — one position is most of the money
- **correlation** — the holdings move together

A book of four names with an average correlation of 0.09 can still be 1.25
effective bets if 77% of it sits in one ticker, and the verdict says exactly that
rather than quoting the correlation as if it were the problem.

## Alerts

Price, percentage-move, per-position and whole-portfolio alerts, evaluated
client-side against quotes the page already polls. No server, no account, nothing
uploaded — and therefore **they only fire while a tab is open**. That limitation
is stated in the UI rather than buried.

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
