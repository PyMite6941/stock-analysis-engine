# Handoff: frontend-only ("direct mode") — what's done, what's left

The goal is a Yahoo-Finance-like site that runs with **no backend and no sign-in**,
and stays secure. This file is for whoever (human or Claude Code) picks up the rest.

## How direct mode works (read this first)

- At startup `App.jsx` calls `/api/health`. JSON back = backend mode (unchanged
  behaviour). A 404, an HTML page or a network error = **direct mode**. Only a real
  `401` shows the login page now.
- `runtime.js` → `backendAvailable()` is the single switch. `api.js` routes
  `quotes`, `candles`, `analyze` and `searchSymbols` to `direct.js` when it's
  false. Every other call throws `ApiError(code: "needs_backend")`.
- `direct.js` talks to **Finnhub** (quotes, names, search, WebSocket stream) and
  **Twelve Data** (price history). Both send `Access-Control-Allow-Origin: *`
  (checked with curl). Yahoo does not, which is why the browser can't use it.
- Keys are the **visitor's own** free keys (`DataKeys.jsx`), kept in localStorage.
  Never bake a key into the bundle: everything in the bundle is public.
- Maths ported from `core/` to JS, with fixture tests generated from the Python:
  `indicators.js` (SMA/EMA/RSI/MACD/Bollinger) and `metrics.js` (return,
  volatility, drawdown, trend, summary).

To try it: `cd frontend && npm run build && npx vite preview`. Preview has no
backend, so it starts in direct mode.

## Done in this change

- Security: CSP + security headers in `vercel.json`; `safeUrl()` blocks
  `javascript:` links from news feeds (React 18 still renders them).
- Direct mode: quotes, charts with indicators, the analysis summary, search, and
  live streaming, all using the visitor's keys.
- Home: market session countdown, "Today's movers" (top 30 US stocks),
  🔑 key setup.
- Analysis page: panels grouped into **Overview / Trade / Portfolio / Research**
  tabs under the chart. Panels that need the server are hidden in direct mode,
  with one note instead of a stack of errors.
- Beginners: paper trading (`paper.js`, `PaperTradePanel.jsx`), new glossary terms.
- Day traders: a standalone position-size and reward:risk calculator
  (`tradeMath.js`, `RiskCalculator.jsx`) that needs no data at all.

## Left to do (most valuable first)

1. **Portfolio valuation in the browser.** `PositionsPanel` calls `/api/portfolio`,
   so in direct mode "My positions" shows a "needs the backend" error. Port
   `core/positions.py` → `value_position`, `portfolio_summary`, `aggregate_lots`
   (the panel reads `positions`, `summary`, `by_symbol`, `unknown_symbols`).
   `positions.js` → `markToMarket` is a partial start. Add a fixture test the same
   way `metrics.test.js` does.
2. **Fundamentals + news via Finnhub.** `/stock/profile2`, `/stock/metric?metric=all`
   and `/company-news` are free and would bring back `FundamentalsPanel` and the
   news part of `InsightsPanel` in direct mode. Pass news URLs through `safeUrl()`.
3. **Port the rest of `core/`** as each panel needs it: `forecast.py`, `daytrade.py`
   (VWAP, pivots, ATR, opening range), `realized.py`/`tax.py`, `income.py`,
   `correlation.py`, `risk.py`, `backtest.py`. Keep the "fixture from Python" test
   pattern so the two sides can't drift apart.
4. **Rate limits.** Twelve Data's free tier is 8 requests/minute. Add a small
   in-memory cache (like the backend's TTL cache) in `direct.js`, keyed by
   symbol+period+interval, so switching timeframes back and forth doesn't
   re-fetch.
5. **Exports in direct mode.** "Export everything" and the XLSX options need the
   server. CSV/JSON already have local fallbacks. XLSX in the browser would need a
   library (e.g. SheetJS); weigh that against keeping dependencies to three.
6. **AI chat without a server** could only be bring-your-own-key, like the data.
   It's hidden in direct mode for now. Don't ship a shared key.
7. **Other static hosts.** The CSP lives in `vercel.json`. For Netlify or
   Cloudflare Pages, copy the same headers into a `_headers` file. Don't add a
   `<meta>` CSP to `index.html`: it would break the Vite dev server and the
   packaged apps.
8. **Backend hygiene (if the backend stays):** `/api/realtime-token` falls back to
   the main `FINNHUB_API_KEY` and sends it to any visitor. Only return the
   dedicated `FINNHUB_WS_TOKEN`. Also, `?api_key=` in download URLs ends up in
   server logs and browser history.

## More ideas for beginners and day traders

- Beginners: a "first stock" guided flow (search → brief → paper-buy); a weekly
  paper-trading recap; a "why did this move?" link to the day's news.
- Day traders: keyboard shortcuts (1–8 for timeframes, / to search); a trade
  journal that records entry, stop and target from the calculator and reports win
  rate and average R; alerts on VWAP or pivot crosses.
