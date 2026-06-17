import { useState, useEffect, Fragment } from "react";
import { statistics as fetchStats } from "../api.js";
import { num, big, pct } from "../format.js";

// rows: [label, group, accessor(stat) -> displayed value]
const ROWS = [
  ["Market Cap", "Valuation", (s) => big(s.valuation.market_cap)],
  ["Trailing P/E", "Valuation", (s) => num(s.valuation.trailing_pe)],
  ["Forward P/E", "Valuation", (s) => num(s.valuation.forward_pe)],
  ["PEG", "Valuation", (s) => num(s.valuation.peg)],
  ["Price/Sales", "Valuation", (s) => num(s.valuation.price_to_sales)],
  ["Price/Book", "Valuation", (s) => num(s.valuation.price_to_book)],
  ["EV/EBITDA", "Valuation", (s) => num(s.valuation.ev_to_ebitda)],
  ["Profit Margin", "Financials", (s) => pct(s.financials.profit_margin)],
  ["ROE", "Financials", (s) => pct(s.financials.roe)],
  ["ROA", "Financials", (s) => pct(s.financials.roa)],
  ["Revenue (ttm)", "Financials", (s) => big(s.financials.revenue_ttm)],
  ["Diluted EPS", "Financials", (s) => num(s.financials.diluted_eps)],
  ["Mean target", "Analyst", (s) => num(s.analyst.target_mean)],
  ["Recommendation", "Analyst", (s) => s.analyst.recommendation_key
    ? s.analyst.recommendation_key.replaceAll("_", " ") : "—"],
];

export default function StatsCompare({ symbols }) {
  const [stats, setStats] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await Promise.all(
          symbols.map((s) => fetchStats(s).catch(() => null))
        );
        if (!cancelled) setStats(res.filter(Boolean));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (symbols.length) load();
    return () => { cancelled = true; };
  }, [symbols.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !stats.length) return <div className="muted chart-empty">Loading comparison stats…</div>;
  if (!stats.length) return null;

  let lastGroup = null;
  return (
    <div className="stats-compare">
      <h3 className="stats-h">Side-by-side statistics</h3>
      <table className="quote-table compare-table">
        <thead>
          <tr>
            <th className="metric-col">Metric</th>
            {stats.map((s) => <th key={s.symbol}>{s.symbol}</th>)}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([label, group, fn]) => {
            const showGroup = group !== lastGroup;
            lastGroup = group;
            return (
              <Fragment key={label}>
                {showGroup && (
                  <tr className="group-row">
                    <td colSpan={stats.length + 1}>{group}</td>
                  </tr>
                )}
                <tr>
                  <td className="metric-col">{label}</td>
                  {stats.map((s) => <td key={s.symbol}>{fn(s)}</td>)}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
