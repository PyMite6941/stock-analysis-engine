import { useState, useEffect } from "react";
import { insights as fetchInsights } from "../api.js";
import { num, pct } from "../format.js";

const PERF_ORDER = ["1W", "1M", "3M", "6M", "YTD", "1Y"];
const REC_PARTS = [
  ["strong_buy", "Strong Buy", "#1b873f"],
  ["buy", "Buy", "#26a69a"],
  ["hold", "Hold", "#b58900"],
  ["sell", "Sell", "#ef5350"],
  ["strong_sell", "Strong Sell", "#b0202a"],
];

function PerfCell({ label, value }) {
  const cls = value == null ? "" : value >= 0 ? "pos" : "neg";
  return (
    <div className="perf-cell">
      <span className="perf-label">{label}</span>
      <span className={`perf-val ${cls}`}>
        {value == null ? "—" : `${value >= 0 ? "+" : ""}${num(value)}%`}
      </span>
    </div>
  );
}

function RecBar({ rec }) {
  const total = REC_PARTS.reduce((s, [k]) => s + (rec[k] || 0), 0);
  if (!total) return <p className="muted">No analyst ratings available.</p>;
  return (
    <>
      <div className="rec-bar">
        {REC_PARTS.map(([k, label, color]) => {
          const n = rec[k] || 0;
          if (!n) return null;
          return <span key={k} style={{ width: `${(n / total) * 100}%`, background: color }}
                       title={`${label}: ${n}`} />;
        })}
      </div>
      <div className="rec-legend">
        {REC_PARTS.map(([k, label, color]) => (
          <span key={k} className="rl-item">
            <span className="rl-dot" style={{ background: color }} /> {label} <b>{rec[k] || 0}</b>
          </span>
        ))}
      </div>
    </>
  );
}

export default function InsightsPanel({ symbol }) {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!symbol) return;
      setLoading(true);
      setError(null);
      try {
        const r = await fetchInsights(symbol);
        if (!cancelled) setD(r);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [symbol]);

  if (loading && !d) return <div className="muted fund-loading">Loading {symbol} insights…</div>;
  if (error) return <div className="error">⚠ {error}</div>;
  if (!d) return null;

  const perf = d.performance || {}, risk = d.risk || {}, inc = d.income || {}, news = d.news || [];

  return (
    <section className="fundamentals stats-panel">
      <h2>Investor insights — {d.symbol}</h2>

      <h3 className="stats-h">Performance (trailing return)</h3>
      <div className="perf-row">
        {PERF_ORDER.map((w) => <PerfCell key={w} label={w} value={perf[w]} />)}
      </div>

      <h3 className="stats-h">Risk profile</h3>
      <div className="fund-grid">
        <div className="fund-stat"><span className="fund-label">Beta</span><span className="fund-value">{num(risk.beta)}</span></div>
        <div className="fund-stat"><span className="fund-label">Annualized volatility</span><span className="fund-value">{pct(risk.annualized_volatility_pct)}</span></div>
        <div className="fund-stat"><span className="fund-label">Max drawdown (1y)</span><span className="fund-value neg">{pct(risk.max_drawdown_pct)}</span></div>
      </div>

      <h3 className="stats-h">Income / dividend</h3>
      <div className="fund-grid">
        <div className="fund-stat"><span className="fund-label">Dividend yield</span><span className="fund-value">{pct(inc.dividend_yield_pct)}</span></div>
        <div className="fund-stat"><span className="fund-label">Annual dividend</span><span className="fund-value">{num(inc.rate)}</span></div>
        <div className="fund-stat"><span className="fund-label">Payout ratio</span><span className="fund-value">{pct(inc.payout_ratio_pct)}</span></div>
        <div className="fund-stat"><span className="fund-label">5y avg yield</span><span className="fund-value">{pct(inc.five_year_avg_yield_pct)}</span></div>
        <div className="fund-stat"><span className="fund-label">Ex-dividend date</span><span className="fund-value">{inc.ex_div_date || "—"}</span></div>
      </div>

      <h3 className="stats-h">Analyst recommendations</h3>
      <RecBar rec={d.recommendation || {}} />

      {news.length > 0 && (
        <>
          <h3 className="stats-h">Recent news</h3>
          <ul className="news-list">
            {news.map((n, i) => (
              <li key={i}>
                <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
                <span className="news-meta">{[n.publisher, n.date].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
