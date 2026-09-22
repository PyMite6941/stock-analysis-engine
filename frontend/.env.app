# Loaded by `vite build --mode app`, which is what the packaged iOS, Android
# and desktop shells run.
#
# A packaged app is not served from the API's origin, so relative "/api/..."
# calls have nowhere to go. Point them at the deployed backend. Change this to
# self-host, or leave it empty to fall back to the default baked into
# src/runtime.js.
VITE_API_BASE=https://stock-analysis-engine.vercel.app
