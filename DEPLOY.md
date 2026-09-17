# Deploying to Vercel

Live at **<https://stock-analysis-engine.vercel.app>**, linked to
`PyMite6941/stock-analysis-engine` on the `matt-g's projects` team. Pushes to
`master` trigger a production deploy automatically — no manual step needed.

## The `uv lock` build failure (fixed 2026-09-16)

Three consecutive pushes deployed successfully *as far as GitHub was concerned*
and then failed at build time, leaving production serving a June build. The
frontend compiled fine; the Python step died:

```
Installing required dependencies from pyproject.toml...
Error: Failed to run "uv lock --python .../bin/python"
error: No `project` table found in: /vercel/path0/pyproject.toml
```

**Cause.** Vercel's Python builder moved to `uv`. When a `pyproject.toml` is
present, `uv lock` runs against it *instead of* reading `requirements.txt`. This
repo's `pyproject.toml` held nothing but pytest config, so `uv lock` failed and
took the whole build with it. Nothing in the application code was wrong — the
last successful deploy simply predated the platform change, so the next push was
the first to hit it.

**Fix.** `pyproject.toml` now carries a real `[project]` table with the runtime
dependencies, plus `[tool.uv] package = false` (there is no installable package
here — `core/` and `backend/` are imported from the repo root by `api/index.py`).
`requirements.txt` is kept in step for local installs.

**Reproduce the build step locally before pushing** — it takes seconds and would
have caught this:

```bash
uv lock            # must exit 0; this is what Vercel runs
cd frontend && npm install && npm run build
```

## Environment variables

Set in **Project → Settings → Environment Variables**.

| Variable | Current | Notes |
|---|---|---|
| `GROQ_API_KEY` | ✅ set | `/api/health` reports `ai_configured: true`. |
| `GROQ_MODEL` | ✅ fine | Verified in production: `provider: groq, model: openai/gpt-oss-120b`. The code default is carrying through, so this does not need setting. |
| `FINNHUB_API_KEY` | optional | Not needed. There is a keyless Yahoo fallback (see below) that covers the throttling case without any signup. If you ever do add a key, the provider auto-upgrades to `hybrid` (real-time quotes from Finnhub, history from yfinance) with no code change. Free at <https://finnhub.io/register> — though their captcha can be obstructive. |
| `DATA_PROVIDER` | unset | Leave it unset. It only exists to *override* the automatic choice (`yfinance` \| `finnhub` \| `hybrid`). Setting it to `yfinance` while a Finnhub key is present would downgrade you. |
| `OPENROUTER_API_KEY` | optional | Fallback when Groq fails. |
| `FINNHUB_WS_TOKEN` | optional | Enables the free client-side live ticker. Use a *throwaway* free key — it is served to the browser. Without it the UI falls back to 30-second polling. |
| `API_KEY` | unset | Gates every endpoint behind a login screen. Leave unset for a public site. |

## Data resilience (no API key required)

yfinance is a scraper: it does a cookie/crumb handshake with Yahoo, and *that*
is the part that breaks — on throttled cloud IPs, and whenever Yahoo changes it.
Underneath sits the v8 chart endpoint, which needs no cookie, no crumb, no key
and no account. So there are two independent paths:

```
quotes / history
  1. yfinance                     primary; also supplies fundamentals,
                                  statistics and insights
       | empty or throttled (3 retries, backoff)
  2. Yahoo v8 chart, keyless      prices only, different code path
       | still nothing
  3. reported as unavailable      NOT as "Stock/ETF not found"
```

Both paths were verified to return identical data (same bar counts, same closes)
for AAPL, NVDA and SPY, so the fallback is a true drop-in rather than a degraded
approximation. It carries no P/E or market cap — the chart endpoint doesn't
expose them — so those read as blank when the fallback is serving.

Step 3 matters as much as step 2: a throttled fetch used to surface to users as
"Stock/ETF not found" for a perfectly real ticker, because an empty result is
indistinguishable from a delisted symbol at that layer.

Failed fetches are deliberately **not** cached, so the next request retries
instead of serving an empty chart for the whole TTL.

## How it is wired

```
vercel.json
  buildCommand      cd frontend && npm install && npm run build
  outputDirectory   frontend/dist          <- static React app
  rewrites          /api/(.*) -> /api/index

api/index.py        re-exports backend.main:app for @vercel/python
pyproject.toml      dependency source of truth for the Python function
```

The frontend calls relative `/api/...`, so production is same-origin and needs
no CORS.

## Verifying a deploy

Check an endpoint that only exists in the new code — `/api/health` has been
there for months and will happily answer from a stale build:

```bash
curl https://stock-analysis-engine.vercel.app/api/health
# data_provider tells you what is REALLY serving data, and
# data_provider_source says whether it was set explicitly or auto-chosen
curl "https://stock-analysis-engine.vercel.app/api/backtest?symbol=AAPL"
curl "https://stock-analysis-engine.vercel.app/api/holdings?symbol=SPY"
```

A 404 on the latter two means production is running old code even though the
push "succeeded". To see why:

```bash
gh api repos/PyMite6941/stock-analysis-engine/deployments?per_page=3 \
  --jq '.[] | "\(.created_at) \(.sha[0:7])"'
gh api repos/PyMite6941/stock-analysis-engine/deployments/<id>/statuses \
  --jq '.[].state'
npx vercel inspect <dpl_id> --logs
```

## Known constraints

- **Cold starts.** The function imports pandas via yfinance, so a cold request
  takes several seconds. The in-process TTL cache and `s-maxage=15` edge headers
  hide most of it once warm.
- **The analysis page is call-heavy** — roughly ten API calls on load. Fine warm,
  noticeable cold.
- **The offline Streamlit app is local-only.** Streamlit needs a persistent
  server and is not part of this deployment.
- **Alerts only fire while a browser tab is open** — they are evaluated
  client-side by design, so there is nothing server-side to deploy for them.
