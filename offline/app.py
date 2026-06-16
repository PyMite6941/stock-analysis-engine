"""Offline analysis frontend — Streamlit. NO AI.

This is the "analyze without the network LLM" path. It imports only the shared
`core` package (data + metrics), so it produces the same numbers as the online
backend but never calls Groq/OpenRouter.

Run from the PROJECT ROOT:

    streamlit run offline/app.py

(The sys.path insert below lets Streamlit find the `core` package even though
it launches the script from the offline/ directory.)
"""

import os
import sys

# Make the project root importable regardless of Streamlit's launch cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pandas as pd
import streamlit as st

from core import data, metrics

st.set_page_config(page_title="Stock Analysis — Offline", layout="wide")
st.title("📊 Stock Analysis Engine — Offline")
st.caption("No AI. Pure data + computed metrics, identical to the online engine's math.")

with st.sidebar:
    st.header("Inputs")
    symbols_raw = st.text_input("Tickers (comma-separated)", "AAPL, MSFT, NVDA")
    period = st.selectbox("History period", ["1mo", "3mo", "6mo", "1y", "2y", "5y"],
                          index=2)
    run = st.button("Analyze", type="primary")
    st.caption(f"Data provider: `{os.environ.get('DATA_PROVIDER', 'yfinance')}`")

if run:
    symbols = [s.strip().upper() for s in symbols_raw.split(",") if s.strip()]
    if not symbols:
        st.warning("Enter at least one ticker.")
        st.stop()

    with st.spinner("Fetching data…"):
        quotes = data.get_quotes(symbols)
        analyses, histories = [], {}
        for sym in symbols:
            hist = data.get_history(sym, period)
            histories[sym] = hist
            analyses.append(metrics.analyze_history(hist))
        summary = metrics.portfolio_summary(quotes, analyses)

    # Top-bar summary
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Symbols", summary["n_symbols"])
    c2.metric("Gainers / Losers", f"{summary['gainers']} / {summary['losers']}")
    c3.metric("Avg P/E", summary["avg_pe"] if summary["avg_pe"] else "—")
    c4.metric("Avg return %", summary["avg_total_return_pct"]
              if summary["avg_total_return_pct"] is not None else "—")
    st.caption(f"Best: **{summary['best_performer']}**  ·  "
               f"Worst: **{summary['worst_performer']}**  ·  "
               f"Most volatile: **{summary['most_volatile']}**")

    # Combined table
    qmap = {q.symbol: q for q in quotes}
    rows = []
    for a in analyses:
        q = qmap.get(a["symbol"])
        rows.append({
            "Symbol": a["symbol"],
            "Name": q.name if q else "",
            "Price": q.price if q else None,
            "Change %": q.change_pct if q else None,
            "P/E": q.pe if q else None,
            "Return %": a["total_return_pct"],
            "Volatility %": a["annualized_volatility_pct"],
            "Max DD %": a["max_drawdown_pct"],
            "Trend": a["trend"],
        })
    df = pd.DataFrame(rows)
    st.subheader("Holdings")
    st.dataframe(df, use_container_width=True, hide_index=True)

    # Download
    st.download_button("⬇ Download CSV", df.to_csv(index=False),
                       file_name="stock_analysis_offline.csv", mime="text/csv")

    # Price charts
    st.subheader("Price history")
    for sym in symbols:
        h = histories[sym]
        if h.closes:
            chart_df = pd.DataFrame({"Close": h.closes}, index=pd.to_datetime(h.dates))
            st.line_chart(chart_df, height=220)
            st.caption(sym)
else:
    st.info("Set tickers in the sidebar and click **Analyze**.")
