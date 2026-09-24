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

## Run it without a backend ("direct mode")

The frontend also works as plain static files (GitHub Pages, Netlify, `vite
preview`). When `/api/health` doesn't answer with JSON, the app fetches prices
straight from Finnhub and Twelve Data using each visitor's **own** free API keys,
saved only in their browser (🔑 on the home page). Charts, indicators, the
summary, search, movers and live streaming work. Panels that need the Python
server are hidden. See `HANDOFF.md` for how it works and what's left to port.

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
| POST | `/api/portfolio/tax` | Form 8949 rows, Schedule D totals, wash sales |
| POST | `/api/portfolio/tax/export` | Form 8949 as CSV, or 8949 + D + wash sales as XLSX |
| POST | `/api/portfolio/events` | upcoming earnings and ex-dividend dates |
| POST | `/api/portfolio/risk` | concentration, correlated clusters, portfolio risk |

A ticker that doesn't exist returns **404** with
`{"error": "symbol_not_found", "detail": "Stock/ETF not found: XYZ..."}` rather
than a generic failure, so the UI can say so plainly.

## Search by company name

Type `nvidia` and get NVDA. The search box suggests matching symbols as you
type — with the asset class, so an ETF tracking a company is distinguishable
from the company — and an exact ticker always wins over a name match, so `KO`
gives Coca-Cola rather than something whose name happens to contain "ko".

Not knowing the ticker was a dead end: the ticker is exactly what a beginner is
trying to find out, so "Stock/ETF not found: NVIDIA" told them nothing they
could act on. The same resolution runs on submit in both the home page and the
analysis page, so a name typed straight into either box works even without
touching the dropdown.

`GET /api/search?q=` is keyless — the same Yahoo endpoint family as the chart
fallback. Futures are filtered out, since searching a company name returns
several of them and this app cannot model any.

## Guided tour

A `?` button top-right starts a spotlight walkthrough: the page dims, the panel
being described stays lit, and the view scrolls to it. Steps whose target isn't
on the page are skipped automatically, so the same tour works on the home page,
in each of the three modes, and before you have any positions. It opens itself
once on a first visit and never again; Escape or the arrow keys work throughout.

## Import from a photo

Screenshot a broker's transaction list — or point a phone camera at it — and a
vision model reads the trades out. `POST /api/import/photo` returns rows and
saves **nothing**.

That last part is deliberate and non-negotiable. Optical recognition misreads
decimal points and will produce a confident-looking wrong number for a smudged
cell, which is the same class of silent error as the Schwab cost-basis bug
above. So every row comes back with a per-row confidence, a list of fields it
could not read, and warnings about anything it had to infer. The review table
is editable inline, rows needing attention are unchecked by default, and
nothing reaches the portfolio until you press the button.

The prompt tells the model to return `null` rather than guess, to skip
dividends and transfers, and to say so explicitly when it divides a total by a
quantity to get a per-unit price.

Needs `GROQ_API_KEY` (or `OPENROUTER_API_KEY`). Without one the button returns
a clear message rather than failing oddly — typing trades in and CSV import
both still work.

Each provider carries a LIST of candidate vision models rather than one id,
because hosted model names churn. This shipped once pointing at a Llama 4 Scout
id Groq had already retired, and the only symptom was a `404` from
`/chat/completions` — which reads like a broken URL, not a missing model. A 404
now falls through to the next model instead of failing the request, and the
error names every model it tried. `GROQ_VISION_MODEL` pins a single id and skips
the list, so a known-good model can be forced from the Vercel dashboard without
a redeploy.

## Crypto, ETFs and mutual funds

The app started as a US-equity tool, and several of its assumptions only hold
there. Each symbol is now classified and the UI adapts, rather than showing
fields that cannot exist:

| Class | Trades | Notable |
|---|---|---|
| Stock | weekdays 09:30-16:00 ET | the original assumptions |
| ETF | weekdays 09:30-16:00 ET | plus holdings and sector weights |
| **Mutual fund** | priced once daily at NAV | **no intraday bars at all**, no volume, no bid/ask; has holdings and an expense ratio |
| **Crypto** | **24/7** | no P/E, no dividends, no earnings; fractional units |
| Index | weekdays | no volume, not day-tradeable |

Two things this fixes rather than merely adds:

**Crypto had a fake trading session.** The intraday filter kept only
09:30-16:00 New York, so a market that never closes was sliced to an arbitrary
six hours — and the pivots, VWAP and opening range were computed from that
slice. For a continuous market the session is now the UTC calendar day (BTC-USD
went from 78 bars to a full day), and the panel says plainly that "today" and
the "opening range" are UTC conventions rather than real market events.

**Mutual funds were offered a day-trading view.** They are priced once a day at
NAV, so there is no session, no VWAP and no opening range — the panel was
rendering figures derived from a single daily print. It now explains why the
view does not apply instead of showing numbers with no referent.

Classification comes from the provider's `quoteType`, falling back to the ticker
shape (`-USD` suffix, `^` prefix, the five-letter-X mutual-fund convention) and
returning `unknown` rather than guessing. `GET /api/asset?symbol=` returns the
class plus capability flags, so a panel asks "does this have intraday data"
instead of re-deriving it.

## Native apps (iOS, Android, desktop)

The same build also ships as real apps — see [APPS.md](APPS.md).

```
frontend/dist ──┬─► apps/mobile  (Capacitor) ─┬─► ios/      Xcode
                │                             └─► android/  Gradle
                └─► apps/desktop (Electron)   ───► Windows / macOS / Linux
```

One codebase: a change in `frontend/` reaches every target on the next build.
Two things differ in a packaged build and both fail *silently*, so both are
handled automatically — assets switch to relative paths (`--mode app`), and API
calls switch to an absolute base because a packaged app is no longer same-origin
with its backend.

Desktop is verified working end to end. Android scaffolds and Gradle runs, but
no APK has been produced yet, and **it cannot be built from this repo's path** —
`ドキュメント` breaks the Gradle wrapper. APPS.md has the workaround.

## Install it on your phone

The app is a PWA: **Add to home screen** gives it its own icon, full-screen
chrome, and — the part that matters for a finance tool — it keeps working
without a connection.

Offline you still get your positions, what you paid, your closed trades and
your alerts, because all of that lives in localStorage anyway. Prices come from
a **per-symbol cache**: every successful response teaches the app about every
ticker in it, so a later request for a different combination can still be
answered. (The service worker's URL-keyed cache can't do this — the home page,
the analysis page and the 30-second poll all ask for different symbol
combinations, so URL matching misses almost every time.)

The rule the whole feature is built around: **a stale price is never shown as
if it were live.** Two distinct states, each with its own banner:

| State | What you see |
|---|---|
| No network | "Offline. Your positions still work. Prices are the last ones loaded — not live (3 min ago)." |
| Network fine, API down | "Showing saved data. Couldn't reach live prices, so these are from 3 min ago. Your own positions and costs are exact." |

That second one exists because `navigator.onLine` cannot detect it — the device
is connected and only the API is failing, so without an explicit signal the page
would quietly serve old numbers. The service worker tags cached responses with
`x-sae-offline` and the age, and the client surfaces both.

Verified with both the API and the web server killed outright: the app still
booted from cache, rendered every price, and labelled them.

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

## Adding a position

Three required fields — stock, shares, price — and nothing else on screen until
you ask for it. Date, notes and exit plan sit behind one toggle, because a form
that asks seven questions to record one purchase is why people give up and use a
spreadsheet instead.

Four things remove work from the common path:

- **The ticker field autocompletes on company name**, the same as the main
  search. Typing `nvidia` offers NVDA.
- **`＋ Add NVDA`** in the panel head prefills whichever stock is on screen,
  which is almost always the one being added. A programmatic prefill
  deliberately does *not* open the autocomplete — the dropdown would cover the
  fields below it and swallow the next click.
- **The live price is offered, not assumed.** One click fills the cost field,
  labelled "only right if you bought today", because the price now and the
  price you paid are the same number on exactly one day.
- **Per-share or total-spent**, as a visible segmented control rather than a
  dropdown. Brokers show both, and which one you remember depends on how you
  bought — "$5,000 of NVDA" is how fractional-share investing works. Either way
  the preview shows the number you did *not* type, which is the one worth
  checking.

The empty state offers all three ways in — type one, import a CSV/XLSX, or
photograph a broker statement. The import button used to appear only once the
list was non-empty, which was exactly backwards for the person who had a
brokerage export sitting in Downloads.

## Buying and selling

A position records a ticker, share count, price paid and — optionally — **when**,
as a date or a date and clock time (`2026-09-16 09:45`). The time matters for
intraday trades: buy and sell inside one session and the holding period is
measured in minutes, not days, and the trade is tagged as a day trade.

A position also carries two free-text fields kept deliberately separate:
**why you bought it**, and **what would make you sell**. They are different
thoughts — the second is a commitment made while you still have no position to
defend — and merging them into one box means the second never gets written. Both
round-trip through CSV/XLSX export and import.

Selling matches against specific lots, which is where the real accounting lives:

| Method | Picks |
|---|---|
| **FIFO** (default) | oldest lots first — what brokers assume if you don't say otherwise |
| **LIFO** | newest lots first |
| **Specific** | lots you name, the only way to deliberately harvest a loss |

Realised gains are split into **short-term** and **long-term** (over one year),
because that split drives the tax bill, and open lots within 45 days of crossing
into long-term treatment get a countdown. A personal record, not a tax document —
your broker's 1099 is the authority.

## Tax forms

`/api/portfolio/tax` turns closed trades into the lines the IRS actually asks
for: **Form 8949** rows in their correct box, and the **Schedule D** subtotals
that flow to the 1040. Two things sit between "what did I make" and "what do I
file", and both are handled here.

**Wash sales.** Sell at a loss and buy substantially identical stock within 30
days *either side*, and the loss is disallowed (IRC 1091). The window is centred
on the sale, so a purchase *before* it counts too — the half of the rule people
miss. The disallowed amount isn't lost: it is added to the basis of the
replacement shares. Every flagged row is shown with the specific purchases that
triggered it, because a number that silently deletes a $5,000 deduction has to
show its working.

Replacement shares are consumed once and earliest-first, so one 100-share rebuy
cannot excuse two separate 100-share losses, and a sale is never treated as its
own replacement.

**Crypto is exempt.** Section 1091 covers "stocks or securities". Crypto is
currently property, so the wash-sale rule does not reach it — selling a coin at
a loss and rebuying immediately keeps the loss, and doing the same with a stock
does not. Applying the rule to crypto would overstate the tax bill, so it is
skipped and the UI says which symbols that applied to.

**Box classification** depends on whether your broker reported cost basis to the
IRS, which only the 1099-B knows. It is an input with a sensible default rather
than a guess presented as fact.

The Schedule D summary also states the **$3,000** annual cap on deducting a net
capital loss against ordinary income, and the carryforward — "I lost $20k so I
deduct $20k" is a common and expensive misunderstanding.

Not tax advice, and not a substitute for the 1099-B. It is a worksheet that
shows its arithmetic so you can check it against the form you receive.

## What's coming up

`/api/portfolio/events` lists the scheduled dates for what you hold: **earnings**
and **ex-dividend**. The probability cone models price as a random walk, which is
a fair description of a quiet week and a bad one for the night a company reports
— so this is the context the maths structurally cannot supply. It says *when*,
never which way.

One subtlety worth recording: Yahoo ships several earnings timestamps and
`earningsTimestamp` is the **last** report, not the next. Reading it alone — the
obvious thing to do — gives a date months in the past for most symbols, so a
forward calendar built on it silently shows nothing. `_next_earnings_date` takes
the earliest candidate still ahead, and falls back to the most recent past date
only when nothing is scheduled. Dates Yahoo inferred from past cadence are
labelled `(est.)`, because they can move by a week.

## Portfolio risk

`/api/portfolio/risk` measures the book as one object rather than a list of
symbols, because the risk of adding a position depends entirely on what you
already hold.

- **Concentration** — largest weight, top-3 weight, and the Herfindahl index,
  reported as `effective_positions` (1/HHI). Ten holdings where one is 80% is a
  one-stock portfolio with decoration, and the number says so.
- **Clusters** — single-link groups of holdings correlated above 0.75. These are
  the positions that will all be red on the same morning: diversification you
  think you have and do not.
- **Portfolio risk** — volatility, Sharpe, Sortino, historical VaR/CVaR and max
  drawdown computed on the *weighted portfolio return series*, not averaged
  across holdings. Averaging per-symbol risk overstates it, because it throws
  away the cancellation that owning different things buys you.

Weights are of market value, not cost. Unpriced holdings are excluded and
counted rather than silently treated as worthless.

## Price freshness

A number on screen means nothing without knowing how old it is and whether the
market is open. The status line distinguishes a live stream from a poll, ages it
in real time, and only calls a price **stale** during a session — an hour-old
price at 2am is simply the closing price, and warning about it would be noise.
Crypto is held to the live standard around the clock.

Market holidays are deliberately not modelled: a hardcoded list rots into wrong
answers. A holiday reads as "open", and the price age catches it anyway, because
no ticks arrive and the clock climbs on its own.

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
