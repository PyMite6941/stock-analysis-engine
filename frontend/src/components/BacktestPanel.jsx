import { useEffect, useState } from "react";
import { backtest as fetchBacktest } from "../api.js";
import { num, pct } from "../format.js";

const HORIZONS = [[5, "1 week"], [21, "1 month"], [63, "3 months"]];
const BAND_LABEL = {
  "strong-bearish": "Strong bearish", bearish: "Bearish", neutral: "Neutral",
  bullish: "Bullish", "strong-bullish": "Strong bullish",
};
const VERDICT_STYLE = {
  predictive: "good", "weak-signal": "mixed", "no-edge": "bad",
  inverted: "bad", "insufficient-data": "unknown",
};

// Does the signal score actually predict anything on this symbol?
//
// This panel exists to falsify the one above it. Every dashboard shows you a
// score; almost none of them show you whether the score has ever worked. When
// the answer is "no edge" or "inverted", that's displayed just as prominently
// as a good result — otherwise the check is theatre.
export default function BacktestPanel({ symbol, beginner = false }) {
  const [horizon, setHorizon] = useState(21);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchBacktest(symbol, "5y", horizon)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, horizon]);

  if (loading) return <section className="panel"><h2>🔬 Has this signal ever worked?</h2>
    <div className="skeleton" style={{ height: 200 }} /></section>;
  if (error) return null;
  if (!data) return null;

  if (!data.available) {
    return (
      <section className="panel">
        <h2>🔬 Has this signal ever worked?</h2>
        <p className="muted small">{data.reason}</p>
      </section>
    );
  }

  const buckets = (data.buckets || []).filter((b) => b.n > 0);
  const maxAbs = Math.max(
    ...buckets.map((b) => Math.abs(b.avg_forward_pct || 0)), 1);
  const style = VERDICT_STYLE[data.verdict] || "unknown";

  return (
    <section className="panel backtest-panel">
      <div className="panel-head">
        <h2>🔬 Has this signal ever worked?</h2>
        <div className="seg small-seg">
          {HORIZONS.map(([h, label]) => (
            <button key={h} className={horizon === h ? "on" : ""}
                    onClick={() => setHorizon(h)}>{label}</button>
          ))}
        </div>
      </div>

      <div className={`verdict-box ${style}`}>
        <span className="verdict-tag">{data.verdict.replace("-", " ")}</span>
        <p>{data.summary}</p>
      </div>

      {beginner && (
        <p className="beginner-note">
          This checks the score against {symbol}'s own past. For every day in the
          last 5 years it works out what the score would have said back then,
          then looks at what the price actually did over the next {horizon}{" "}
          trading days. If high scores weren't followed by better returns, the
          score isn't predicting anything — and this panel will say so.
        </p>
      )}

      <div className="table-wrap">
        <table className="data-table backtest-table">
          <thead>
            <tr>
              <th>Score band</th><th>Days</th>
              <th>Avg next {horizon}d</th><th>vs doing nothing</th>
              <th>Went up</th><th>Best</th><th>Worst</th><th />
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.band}>
                <td className={`band-${b.band}`}>{BAND_LABEL[b.band] || b.band}</td>
                <td className="muted">{b.n}</td>
                <td className={`strong ${b.avg_forward_pct >= 0 ? "up" : "down"}`}>
                  {b.avg_forward_pct >= 0 ? "+" : ""}{pct(b.avg_forward_pct)}
                </td>
                <td className={b.excess_vs_baseline_pct >= 0 ? "up" : "down"}>
                  {b.excess_vs_baseline_pct >= 0 ? "+" : ""}
                  {pct(b.excess_vs_baseline_pct)}
                </td>
                <td>{pct(b.hit_rate_pct, 1)}</td>
                <td className="up">{pct(b.best_pct)}</td>
                <td className="down">{pct(b.worst_pct)}</td>
                <td className="bt-bar-cell">
                  <span className={`bt-bar ${b.avg_forward_pct >= 0 ? "up" : "down"}`}
                        style={{
                          width: `${(Math.abs(b.avg_forward_pct) / maxAbs) * 46}%`,
                          left: b.avg_forward_pct >= 0 ? "50%" : "auto",
                          right: b.avg_forward_pct < 0 ? "50%" : "auto",
                        }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bt-stats">
        <span>Baseline (any random day): <strong>{pct(data.baseline_forward_pct)}</strong></span>
        <span>Bullish − bearish: <strong className={data.bull_minus_bear_pct >= 0 ? "up" : "down"}>
          {data.bull_minus_bear_pct >= 0 ? "+" : ""}{pct(data.bull_minus_bear_pct)}
        </strong></span>
        <span>Rises consistently: <strong>{data.monotonic ? "yes" : "no"}</strong></span>
      </div>

      <p className="fine-print">
        {num(data.bars_tested, 0)} days tested, but consecutive days share most of
        their {horizon}-day forward window, so the honest sample size is about{" "}
        <strong>{data.independent_samples}</strong> independent observations
        {!data.reliable && " — too few to conclude anything"}. Scores are computed
        point-in-time: only data available on that day feeds the score, and the
        forward return is measured strictly afterwards. One symbol over one
        5-year window is not evidence about markets in general.
      </p>
    </section>
  );
}
