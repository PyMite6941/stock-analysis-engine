import { useState, useEffect } from "react";
import { statistics as fetchStats } from "../api.js";
import { num, big, pct } from "../format.js";

function StatGrid({ rows }) {
  return (
    <div className="fund-grid">
      {rows.map(([label, value]) => (
        <div className="fund-stat" key={label}>
          <span className="fund-label">{label}</span>
          <span className="fund-value">{value}</span>
        </div>
      ))}
    </div>
  );
}

// Analyst price-target gauge: low — current — average — high.
function TargetBar({ a }) {
  const { target_low: lo, target_high: hi, current_price: cur, target_mean: avg } = a;
  if (lo == null || hi == null || hi <= lo) return null;
  const pos = (v) => `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100))}%`;
  return (
    <div className="target-wrap">
      <div className="target-bar">
        {cur != null && <span className="target-mark cur" style={{ left: pos(cur) }} title={`Current ${num(cur)}`} />}
        {avg != null && <span className="target-mark avg" style={{ left: pos(avg) }} title={`Avg ${num(avg)}`} />}
      </div>
      <div className="target-ends">
        <span>Low {num(lo)}</span>
        <span className="muted">Avg {num(avg)} · Cur {num(cur)}</span>
        <span>High {num(hi)}</span>
      </div>
    </div>
  );
}

// Quarterly revenue vs. earnings bars (no chart lib — scaled divs).
function RevEarnings({ quarters }) {
  if (!quarters?.length) return <p className="muted">No quarterly data.</p>;
  const max = Math.max(...quarters.flatMap((q) => [q.revenue || 0, q.earnings || 0]), 1);
  return (
    <div className="revearn">
      {quarters.map((q) => (
        <div className="re-col" key={q.quarter}>
          <div className="re-bars">
            <div className="re-bar rev" style={{ height: `${((q.revenue || 0) / max) * 100}%` }}
                 title={`Revenue ${big(q.revenue)}`} />
            <div className="re-bar earn" style={{ height: `${((q.earnings || 0) / max) * 100}%` }}
                 title={`Earnings ${big(q.earnings)}`} />
          </div>
          <div className="re-label">{q.quarter}</div>
        </div>
      ))}
    </div>
  );
}

export default function StatisticsPanel({ symbol }) {
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!symbol) return;
      setLoading(true);
      setError(null);
      try {
        const d = await fetchStats(symbol);
        if (!cancelled) setS(d);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [symbol]);

  if (loading && !s) return <div className="muted fund-loading">Loading {symbol} statistics…</div>;
  if (error) return <div className="error">⚠ {error}</div>;
  if (!s) return null;

  const v = s.valuation, fin = s.financials, a = s.analyst, e = s.earnings;

  return (
    <section className="fundamentals stats-panel">
      <h2>Statistics &amp; analysis — {s.symbol}</h2>

      <h3 className="stats-h">Analyst insights</h3>
      <TargetBar a={a} />
      <StatGrid rows={[
        ["Recommendation", a.recommendation_key ? a.recommendation_key.replaceAll("_", " ") : "—"],
        ["Rating (1=Buy, 5=Sell)", num(a.recommendation_mean)],
        ["# Analysts", a.num_analysts ?? "—"],
        ["Mean target", num(a.target_mean)],
      ]} />

      <h3 className="stats-h">Valuation measures</h3>
      <StatGrid rows={[
        ["Market Cap", big(v.market_cap)],
        ["Enterprise Value", big(v.enterprise_value)],
        ["Trailing P/E", num(v.trailing_pe)],
        ["Forward P/E", num(v.forward_pe)],
        ["PEG Ratio", num(v.peg)],
        ["Price/Sales (ttm)", num(v.price_to_sales)],
        ["Price/Book", num(v.price_to_book)],
        ["EV/Revenue", num(v.ev_to_revenue)],
        ["EV/EBITDA", num(v.ev_to_ebitda)],
      ]} />

      <h3 className="stats-h">Financial highlights</h3>
      <StatGrid rows={[
        ["Profit Margin", pct(fin.profit_margin)],
        ["Return on Assets", pct(fin.roa)],
        ["Return on Equity", pct(fin.roe)],
        ["Revenue (ttm)", big(fin.revenue_ttm)],
        ["Net Income (ttm)", big(fin.net_income)],
        ["Diluted EPS (ttm)", num(fin.diluted_eps)],
        ["Total Cash", big(fin.total_cash)],
        ["Debt/Equity", fin.debt_to_equity != null ? `${num(fin.debt_to_equity)}%` : "—"],
        ["Levered Free Cash Flow", big(fin.levered_fcf)],
      ]} />

      <h3 className="stats-h">
        Revenue vs. earnings
        <span className="legend-inline">
          <span className="dot rev" /> Revenue <span className="dot earn" /> Earnings
        </span>
      </h3>
      <RevEarnings quarters={e.quarterly} />
    </section>
  );
}
