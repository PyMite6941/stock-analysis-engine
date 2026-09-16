import { useEffect, useState } from "react";
import { portfolioForecast } from "../api.js";
import { num, pct } from "../format.js";
import Explain from "./Explain.jsx";

// Probability cone for the whole book rather than one symbol.
//
// Not the average of the per-symbol cones: correlations are already baked into
// the combined value series, so this is genuinely narrower than the pieces
// whenever the holdings are diversified. That's the honest way to answer "how
// much could my portfolio be worth in 3 months".
export default function PortfolioForecastPanel({ positions, beginner = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!positions.length) { setData(null); return; }
    setLoading(true);
    portfolioForecast(positions, "2y")
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [positions]);

  if (!positions.length) return null;
  if (loading && !data) return <section className="panel"><h2>🎯 Where this portfolio could go</h2>
    <div className="skeleton" style={{ height: 200 }} /></section>;
  if (error) return null;
  if (!data) return null;

  if (!data.available) {
    return (
      <section className="panel">
        <h2>🎯 Where this portfolio could go</h2>
        <p className="muted small">{data.reason}</p>
      </section>
    );
  }

  const rows = Object.entries(data.bands || {});
  const current = data.current_value;

  // Scale every bar against the widest band so the cone visibly widens.
  const widest = Math.max(...rows.map(([, b]) => Math.max(
    Math.abs(b.p95 - current), Math.abs(current - b.p5))), 1);

  return (
    <section className="panel pf-forecast-panel">
      <h2>🎯 Where this portfolio could go</h2>

      {beginner && (
        <p className="beginner-note">
          This is a range, not a prediction. It says: if your holdings keep
          behaving the way they have, here's where the total value tends to land.
          The wide bars are the point — the further out you look, the less
          anyone knows.
        </p>
      )}

      <p className="pf-current">
        Today: <strong>${num(current)}</strong> across {data.n_symbols} holdings,
        modelled on {data.n_days} trading days of combined history.
      </p>

      <div className="cone">
        {rows.map(([label, b]) => {
          const leftPad = ((current - b.p5) / widest) * 50;
          const rightPad = ((b.p95 - current) / widest) * 50;
          const q1 = ((current - b.p25) / widest) * 50;
          const q3 = ((b.p75 - current) / widest) * 50;
          return (
            <div key={label} className="cone-row">
              <span className="cone-label">{label}</span>
              <span className="cone-track">
                <span className="cone-outer"
                      style={{ left: `${50 - leftPad}%`, width: `${leftPad + rightPad}%` }} />
                <span className="cone-inner"
                      style={{ left: `${50 - q1}%`, width: `${q1 + q3}%` }} />
                <span className="cone-now" />
                <span className="cone-mid"
                      style={{ left: `${50 + ((b.p50 - current) / widest) * 50}%` }} />
              </span>
              <span className={`cone-mid-val ${b.p50_change >= 0 ? "up" : "down"}`}>
                {b.p50_change >= 0 ? "+" : "−"}${num(Math.abs(b.p50_change), 0)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Horizon</th><th>Bad case (5%)</th><th>Low</th>
              <th>Midpoint</th><th>High</th><th>Good case (5%)</th>
              <th>Chance you're up</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, b]) => (
              <tr key={label}>
                <td className="strong">{label}</td>
                <td className="down">
                  ${num(b.p5, 0)}
                  <div className="muted tiny">{pct((b.p5 / current - 1) * 100, 0)}</div>
                </td>
                <td>${num(b.p25, 0)}</td>
                <td className="strong">
                  ${num(b.p50, 0)}
                  <div className={`tiny ${b.p50_change >= 0 ? "up" : "down"}`}>
                    {b.p50_change >= 0 ? "+" : ""}${num(b.p50_change, 0)}
                  </div>
                </td>
                <td>${num(b.p75, 0)}</td>
                <td className="up">
                  ${num(b.p95, 0)}
                  <div className="muted tiny">+{pct((b.p95 / current - 1) * 100, 0)}</div>
                </td>
                <td>{pct(b.prob_gain_pct, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mini-stats">
        <div><dt>Portfolio <Explain term="Volatility" enabled={beginner}>vol</Explain></dt>
          <dd>{pct(data.annualized_volatility_pct)}</dd></div>
        {data.risk?.sharpe != null && (
          <div><dt><Explain term="Sharpe" enabled={beginner}>Sharpe</Explain></dt>
            <dd>{num(data.risk.sharpe)}</dd></div>
        )}
        {data.risk?.max_drawdown_pct != null && (
          <div><dt>Worst fall</dt><dd className="down">{pct(data.risk.max_drawdown_pct)}</dd></div>
        )}
        {data.risk?.var_95_pct != null && (
          <div><dt>1-day 95% <Explain term="VaR" enabled={beginner}>VaR</Explain></dt>
            <dd className="down">{pct(data.risk.var_95_pct)}</dd></div>
        )}
      </div>

      <p className="fine-print disclaimer-inline">
        Built from how these exact holdings moved together over the last{" "}
        {data.n_days} trading days, using today's share counts throughout. Because
        the holdings are combined before the maths, correlation is already
        included — this cone is narrower than adding up the individual ones, which
        is what diversification actually buys you. Drift is halved, as elsewhere.
        Not a prediction, and not financial advice.
      </p>
    </section>
  );
}
