# Stock Analysis Engine — Feature Overview

## Architecture

```
core/        Shared Python: data fetching (pluggable API) + analysis math. NO AI.
backend/     FastAPI: serves data, CSV download, and the AI chat proxy.
frontend/    React + Vite: tables, charts, AI chat panel, download button.
offline/     Streamlit: offline analysis reusing core/. NO AI, no keys needed.
```

`core/` is the single source of truth for numbers, so the offline Streamlit math
is identical to the online backend math. The AI lives only in `backend/` and
`frontend/` — the offline path never imports it.

---

## Backend Features

### Data Fetching (`core/data.py`)
- Live stock quotes (price, change, P/E, market cap, name)
- Historical price data (OHLCV with configurable period/interval)
- Close-only history
- Company fundamentals (sector, industry, business summary, price ranges, volume, beta, earnings date, dividends, analyst target)
- Full valuation & financial statistics (market cap, EV, PE/PS/PB ratios, profit margins, ROA/ROE, debt/equity, cash flow)
- Analyst information (price targets, recommendation mean, analyst count)
- Quarterly earnings history (revenue and net income, last 4 quarters)
- Dividend/income data (rate, yield, payout ratio, 5yr avg)
- Analyst recommendation splits (strong buy / buy / hold / sell / strong sell)
- Recent news (up to 6 articles per symbol)
- Pluggable data providers: **yfinance** (default, no key) or **Finnhub** (REST key)
- Parallel symbol fetching via `ThreadPoolExecutor`
- In-process TTL cache (5 min for info, 15 sec for candles)
- Intraday intervals (1m, 2m, 5m, 15m, 30m, 1h, 3h)
- Resampling support (e.g., 3h from 1h bars)

### Metrics & Analysis (`core/metrics.py`)
- Total return percentage
- Annualized volatility (daily std dev × √252)
- Maximum drawdown (peak-to-trough)
- Simple Moving Averages (SMA-20, SMA-50, SMA-200)
- Exponential Moving Average (EMA-20)
- Trend signal classification (strong-uptrend, uptrend, downtrend, strong-downtrend)
- Trailing return performance over 1W, 1M, 3M, 6M, 1Y, YTD windows
- Portfolio-level summary (count, gainers/losers, avg P/E, avg return, avg volatility, best/worst/most-volatile)

### Technical Indicators (`core/indicators.py`)
- Simple Moving Average (SMA)
- Exponential Moving Average (EMA)
- Relative Strength Index (RSI, Wilder's, period 14)
- MACD (default 12/26/9) — line, signal, histogram
- Bollinger Bands (default 20/2) — mid, upper, lower
- Bundled `compute_all()` returning all indicators at once

### AI / Chat (`backend/ai.py`)
- Multi-provider AI chat with automatic fallback: **Groq** → **OpenRouter**
- Grounded analysis — system prompt injects live quotes + computed metrics as JSON context
- Configurable models via env vars (`GROQ_MODEL`, `OPENROUTER_MODEL`)
- Equity research assistant persona with risk disclaimer
- Temperature 0.3 for factual, balanced responses
- 60-second timeout per provider

### API Endpoints (`backend/main.py`)

| Method | Path | Purpose | Parameters |
|--------|------|---------|------------|
| GET | `/api/health` | Status + active data + AI provider | — |
| GET | `/api/quotes` | Live quotes for 1+ symbols | `symbols` (comma-separated) |
| GET | `/api/history` | Close-only price history | `symbol`, `period` |
| GET | `/api/fundamentals` | Company info panel | `symbol` |
| GET | `/api/statistics` | Valuation, financials, analyst data | `symbol` |
| GET | `/api/insights` | Performance, risk, dividends, recs, news | `symbol` |
| GET | `/api/candles` | OHLCV + technical indicators for charting | `symbol`, `period`, `interval` |
| POST | `/api/analyze` | Full multi-symbol analysis | `{symbols, period}` |
| POST | `/api/chat` | AI chat grounded in live data | `{messages, symbols, period}` |
| GET | `/api/download.csv` | CSV export of candle data | `symbols`, `period` |

### Infrastructure
- **Vercel serverless deployment** via `api/index.py` (re-exports FastAPI app)
- **CORS middleware** (Vite dev server on port 5173)
- **Edge caching middleware** (`s-maxage=15`, `stale-while-revalidate=60`)
- **Offline Streamlit app** (`offline/app.py`) reuses `core/` — no AI, no keys
- **Environment-variable-based configuration** for data provider and AI keys

---

## Frontend Features

### Pages
| View | Component | Purpose |
|------|-----------|---------|
| **Home Dashboard** | `HomePage` | Major indices + saved watchlist cards, search bar |
| **Analysis Page** | `AnalysisView` | Full analysis for 1+ symbols: charts, data panels, AI chat |

### Components
| Component | Purpose |
|-----------|---------|
| **HomePage** | Shows 5 major indices (S&P 500, Nasdaq, Dow, Russell 2000, VIX) and localStorage-persisted watchlist as clickable cards; search bar with live filtering |
| **AnalysisView** | Orchestrates all analysis panels; manages symbol input, period selector, CSV download, watchlist persistence |
| **SummaryBar** | 4 aggregate cards (symbols, gainers/losers, avg P/E, avg return) + best/worst/most-volatile text |
| **QuoteTable** | 10-column table: Symbol, Name, Price, Chg%, P/E, Mkt Cap, Return%, Vol%, Max DD%, Trend; clickable rows set focused symbol |
| **ChartSection** | Timeframe selector (1D/5D/1M/3M/6M/1Y/2Y/5Y), chart type (Area/Candles/Hollow/OHLC/Heikin-Ashi), indicator toggles (SMA 20/50/200, EMA 20, Bollinger, Volume, RSI, MACD), settings (log/lin scale, gridlines, crosshair), single vs compare toggle |
| **CandleChart** | Renders multi-pane chart via `lightweight-charts` (TradingView). Main price pane + overlay indicators + lower panes for Volume, RSI (with 30/70 lines), MACD (histogram + signal/MACD lines). Handles Heikin-Ashi OHLC derivation, intraday UTC formatting, dark theme |
| **ComparisonChart** | Multi-symbol normalized % change overlay chart with colored legend |
| **FundamentalsPanel** | 16-key-stat grid (Prev Close, Open, Bid/Ask, Range, 52W, Volume, Mkt Cap, Beta, P/E, EPS, Earnings Date, Dividend, Target) + collapsible company summary |
| **StatisticsPanel** | Price target gauge bar, 9 valuation metrics, 9 financial highlights, revenue vs earnings bar chart (pure CSS) |
| **InsightsPanel** | Trailing returns (6 periods), risk profile (beta, volatility, drawdown), dividend data, analyst recommendations (stacked bar), recent news feed |
| **StatsCompare** | Side-by-side 14-metric comparison table across all watchlist symbols |
| **ChatPanel** | AI analyst chat with suggestion chips, message history, provider/model metadata |
| **PriceChart** | Deprecated stub (replaced by CandleChart) |

### Interactive Features (New)
- **Live price polling** — Quotes auto-refresh every 30s on the analysis page without full re-analysis; timestamp shown in UI
- **Full-screen chart** — Toggle fullscreen mode via button in chart controls; chart resizes to viewport height
- **Dark/light theme** — Toggle button in header on both pages; persisted in localStorage; smooth CSS transitions
- **Chart drawing tools** — Drawing mode (✏ button) lets you click the chart to place horizontal price level lines; levels are persisted in localStorage; clear button to remove all
- **Touch-friendly interactions** — Swipe left/right on the chart to cycle through timeframes; pinch-to-zoom and vertical touch-drag support via lightweight-charts

### Loading & UX
- **Loading skeletons** — Shimmer placeholders for market standings (home page) and analysis layout (summary cards, chart, table, chat sidebar)
- **Fade-in animations** — Panels, summary bar, and quote table animate in on data load with staggered delays
- **Smooth theme transitions** — Background, border, and text colors transition over 300ms when toggling themes

### Export Formats
| Format | Method |
|--------|--------|
| **CSV** | Direct download link (`/api/download.csv`) |
| **JSON** | Blob download of full analysis data |
| **PDF** | Print-to-PDF via `window.print()` with optimized print stylesheet |

### Technical Details
- **Stack:** React 18, Vite 5, lightweight-charts 5.x
- **No TypeScript**, no Tailwind, no React Router, no state management library
- **Pure CSS** with CSS custom properties (dark theme, GitHub-dark inspired palette); light theme variant via `.light` class
- **API client** (`src/api.js`) — thin fetch-based client for all backend endpoints
- **Persistence** via localStorage — watchlist, focused symbol, chart preferences (timeframe, type, indicators, settings, theme, draw levels)
- **Formatting utilities** (`src/format.js`) — localized numbers, human-readable large values, percentages
- **Vite proxy** — `/api` proxied to `http://localhost:8000` in dev

---

## Data Providers

| Provider | Key Required | Best For |
|----------|-------------|----------|
| **yfinance** | No | Local dev, offline mode |
| **Finnhub** | `FINNHUB_API_KEY` | Production / cloud (Vercel) |

## AI Providers

| Provider | Key Required | Model (default) |
|----------|-------------|-----------------|
| **Groq** | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| **OpenRouter** | `OPENROUTER_API_KEY` | `meta-llama/llama-3.3-70b-instruct` |

Fallback chain: Groq → OpenRouter. Both are OpenAI-compatible.

---

## Mobile Responsiveness

The frontend is fully responsive with three breakpoints:

| Breakpoint | Changes |
|------------|---------|
| **≤ 1000px** | Two-column layout collapses to single column; sidebar becomes static |
| **≤ 768px** | Reduced padding/fonts; stacked controls & search; table horizontal scroll (overflow-x); chart 560→320px; standing grids 160px min; segment buttons wrap; settings popover anchors left |
| **≤ 480px** | Standing cards single column; chart 320→260px; performance grid 3 columns; tighter summary cards; smaller segment buttons |

Touch features: swipe to cycle timeframes, pinch-to-zoom, vertical touch-drag scrolling on chart. All interactive controls have adequate tap targets at mobile sizes.

## Key Design Decisions
- No database — fully stateless, data fetched live from external APIs
- `core/` shared between online (FastAPI) and offline (Streamlit) — guaranteed identical math
- AI lives only in `backend/` and `frontend/` — offline mode has zero AI dependencies
- Same-origin in production (Vercel) — no CORS needed after deploy
- Chart preferences persist in localStorage across sessions
