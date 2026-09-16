# Deploying to Vercel

> **Status (2026-09-16): not currently deployed.** The Vercel project this repo
> used to be linked to no longer exists — the only project on the
> `matt-g's projects` team is `fitness-ai-agents`. The stale `.vercel/` link file
> has been removed so a fresh link starts clean. Pushing to GitHub does nothing
> until the steps below are done once.

## One-time setup

### Option A — Vercel dashboard (easiest)

1. <https://vercel.com/new> → **Import Git Repository**
2. Pick `PyMite6941/stock-analysis-engine`
3. Framework preset: **Other** — do not let it guess Vite, because `vercel.json`
   already supplies the build command and output directory
4. Add the environment variables in the table below **before** the first deploy,
   so the first build comes up working
5. **Deploy**

### Option B — CLI

```bash
npm i -g vercel
vercel login          # interactive — run this yourself
vercel link           # creates the project and writes .vercel/
vercel --prod
```

Both are interactive, so they need a human at the keyboard.

## Environment variables

Set these in **Project → Settings → Environment Variables** (Production, and
Preview if you want previews to work too).

| Variable | Value | Why |
|---|---|---|
| `DATA_PROVIDER` | `hybrid` (or `finnhub`) | **Important.** yfinance is unreliable from cloud IPs — Yahoo throttles datacentre ranges. `hybrid` takes real-time quotes from Finnhub's free tier and history from yfinance. |
| `FINNHUB_API_KEY` | your free key | Needed by `hybrid` and `finnhub`. Free at <https://finnhub.io/register>, no card. |
| `GROQ_API_KEY` | your Groq key | The AI analyst. Without it `/api/chat` returns 503 and the rest of the app still works. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | **Check this one.** Groq decommissioned `llama-3.3-70b-versatile` on 2026-06-17. If an old value is set here it overrides the code default and the analyst stays broken. Leaving it unset is fine — the code already defaults correctly. |
| `OPENROUTER_API_KEY` | optional | Fallback if Groq fails. |
| `FINNHUB_WS_TOKEN` | optional | Enables the free client-side live ticker. Use a *throwaway* free key: it is served to the browser. Without it the UI falls back to 30-second polling. |
| `API_KEY` | optional | Gates every endpoint behind a login screen. Leave unset for a public site. |

## How the deployment is wired

```
vercel.json
  buildCommand      cd frontend && npm install && npm run build
  outputDirectory   frontend/dist          <- static React app
  rewrites          /api/(.*) -> /api/index
```

`api/index.py` re-exports `backend.main:app`, and Vercel's `@vercel/python`
runtime serves any module-level `app` found under `/api`. Root
`requirements.txt` is the dependency list for that function — it deliberately
omits `uvicorn` (Vercel provides the server) and includes `openpyxl` and
`python-multipart` for the XLSX export/import.

Because the frontend calls relative `/api/...`, production is same-origin and
needs no CORS.

## Verifying a deploy

```bash
curl https://<your-deployment>/api/health
# {"status":"ok","data_provider":"hybrid","ai_configured":true}
```

`ai_configured: false` means no AI key reached the function. Then check a real
data call and the AI:

```bash
curl "https://<your-deployment>/api/quotes?symbols=AAPL"
curl -X POST https://<your-deployment>/api/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"symbols":["AAPL"]}'
```

## Known constraints

- **Cold starts.** The Python function imports pandas via yfinance, so a cold
  request can take several seconds. The in-process TTL cache and the
  `s-maxage=15` edge headers hide most of this once warm.
- **The analysis page is call-heavy.** It fires roughly ten API calls on load
  (portfolio, realised, income, forecast, correlation, compare, backtest, plus
  per-symbol panels). Fine on a warm instance; noticeable on a cold one.
- **The offline Streamlit app is local-only.** Streamlit needs a persistent
  server and is not part of this deployment.
- **Alerts only fire while a browser tab is open** — they are evaluated
  client-side by design, so there is nothing server-side to deploy for them.
