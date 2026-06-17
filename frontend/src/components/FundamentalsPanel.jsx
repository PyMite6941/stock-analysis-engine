import { useState, useEffect } from "react";
import { fundamentals as fetchFundamentals } from "../api.js";

function num(n, digits = 2) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function bigNum(n) {
  if (!n) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return num(n, 0);
}

export default function FundamentalsPanel({ symbol }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!symbol) return;
      setLoading(true);
      setError(null);
      try {
        const d = await fetchFundamentals(symbol);
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [symbol]);

  if (loading && !data) return <div className="muted fund-loading">Loading {symbol} fundamentals…</div>;
  if (error) return <div className="error">⚠ {error}</div>;
  if (!data) return null;

  const f = data;
  const range = (lo, hi) => (lo != null && hi != null) ? `${num(lo)} – ${num(hi)}` : "—";
  const bidAsk = (p, s) => (p != null) ? `${num(p)}${s != null ? ` x ${s}` : ""}` : "—";
  const dividend = (f.forward_dividend != null || f.dividend_yield_pct != null)
    ? `${f.forward_dividend != null ? num(f.forward_dividend) : "--"}` +
      `${f.dividend_yield_pct != null ? ` (${num(f.dividend_yield_pct)}%)` : ""}`
    : "--";

  const stats = [
    ["Previous Close", num(f.previous_close)],
    ["Open", num(f.open)],
    ["Bid", bidAsk(f.bid, f.bid_size)],
    ["Ask", bidAsk(f.ask, f.ask_size)],
    ["Day's Range", range(f.day_low, f.day_high)],
    ["52 Week Range", range(f.week52_low, f.week52_high)],
    ["Volume", bigNum(f.volume)],
    ["Avg. Volume", bigNum(f.avg_volume)],
    ["Market Cap", bigNum(f.market_cap)],
    ["Beta (5Y Monthly)", num(f.beta)],
    ["PE Ratio (TTM)", num(f.pe_ttm)],
    ["EPS (TTM)", num(f.eps_ttm)],
    ["Earnings Date (est.)", f.earnings_date || "—"],
    ["Forward Dividend & Yield", dividend],
    ["Ex-Dividend Date", f.ex_dividend_date || "--"],
    ["1y Target Est", num(f.target_mean_price)],
  ];

  return (
    <section className="fundamentals">
      <div className="fund-head">
        <h2>{f.name} <span className="fund-sym">({f.symbol})</span></h2>
        {(f.sector || f.industry) && (
          <p className="fund-sector">{[f.sector, f.industry].filter(Boolean).join(" · ")}</p>
        )}
      </div>

      <div className="fund-grid">
        {stats.map(([label, value]) => (
          <div className="fund-stat" key={label}>
            <span className="fund-label">{label}</span>
            <span className="fund-value">{value}</span>
          </div>
        ))}
      </div>

      {f.summary && (
        <details className="fund-summary" open>
          <summary>Company summary</summary>
          <p>{f.summary}</p>
        </details>
      )}
    </section>
  );
}
