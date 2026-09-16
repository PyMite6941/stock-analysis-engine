import { useEffect, useState } from "react";
import { forecast as fetchForecast } from "../api.js";
import { num, pct } from "../format.js";
import Explain from "./Explain.jsx";

// Projections, probability cone, signal score, risk stats and S/R levels.
//
// The layout deliberately leads with the signal score and the honesty caveats,
// then shows the numbers. A forecast panel that looks more confident than the
// maths is the failure mode worth designing against.
export default function ForecastPanel({ symbol, beginner = false, period = "1y" }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState("");
  const [targetDays, setTargetDays] = useState(21);
  const [targetResult, setTargetResult] = useState(null);
  const [targetBusy, setTargetBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTargetResult(null);
    fetchForecast(symbol, period)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, period]);

  async function checkTarget(e) {
    e.preventDefault();
    const t = Number(target);
    if (!t || t <= 0) return;
    setTargetBusy(true);
    try {
      const d = await fetchForecast(symbol, period, t, targetDays);
      setTargetResult(d.target || null);
    } catch (err) {
      setTargetResult({ error: err.message });
    } finally {
      setTargetBusy(false);
    }
  }

  if (loading) return <section className="panel"><h2>🔮 Outlook</h2>
    <div className="skeleton" style={{ height: 260 }} /></section>;
  if (error) return <section className="panel"><h2>🔮 Outlook</h2>
    <p className="error-inline">⚠ {error}</p></section>;
  if (!data) return null;

  const { signal, trend, bands, risk, levels, current_price: price } = data;
  const bandRows = bands?.bands ? Object.entries(bands.bands) : [];

  return (
    <section className="panel forecast-panel">
      <h2>🔮 Outlook &amp; projections</h2>

      {beginner && (
        <p className="beginner-note">
          Nobody can predict a share price. What follows is what the past year of
          this stock's own behaviour implies — a range of outcomes and how likely
          each one is, not a forecast of what will happen.
        </p>
      )}

      {signal?.label && (
        <div className="signal-block">
          <div className={`signal-gauge ${signal.label}`}>
            <div className="signal-score">{signal.score > 0 ? "+" : ""}{signal.score}</div>
            <div className="signal-label">{signal.label.replace("-", " ")}</div>
            <div className="signal-track">
              <div className="signal-fill"
                   style={{ width: `${Math.min(Math.abs(signal.score), 100) / 2}%`,
                            left: signal.score >= 0 ? "50%" : "auto",
                            right: signal.score < 0 ? "50%" : "auto" }} />
              <div className="signal-mid" />
            </div>
            <div className="signal-scale"><span>−100 bearish</span><span>bullish +100</span></div>
          </div>
          <div className="signal-factors">
            <h3>What drives that score</h3>
            {Object.entries(signal.factors || {}).map(([key, f]) => (
              <div key={key} className="factor-row">
                <div className="factor-head">
                  <span className="factor-name">{key.replace("_", " ")}</span>
                  <span className={`factor-val ${f.score >= 0 ? "up" : "down"}`}>
                    {f.score > 0 ? "+" : ""}{f.score.toFixed(2)}
                    <em> ×{f.weight}</em>
                  </span>
                </div>
                <div className="factor-bar">
                  <div className={`factor-fill ${f.score >= 0 ? "up" : "down"}`}
                       style={{ width: `${Math.abs(f.score) * 50}%`,
                                left: f.score >= 0 ? "50%" : "auto",
                                right: f.score < 0 ? "50%" : "auto" }} />
                </div>
                <p className="factor-note">{f.note}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {bandRows.length > 0 && (
        <>
          <h3 className="sub-head">
            Probability cone
            <span className="hint">
              Where the price lands if it keeps behaving the way it has been.
              The middle column is the midpoint; the outer columns are the 1-in-20
              cases at each end.
            </span>
          </h3>
          <div className="table-wrap">
            <table className="data-table cone-table">
              <thead>
                <tr>
                  <th>Horizon</th>
                  <th>Worst 5%</th><th>Low</th><th>Midpoint</th><th>High</th><th>Best 5%</th>
                  <th>Chance it's up</th>
                  <th>Typical swing</th>
                </tr>
              </thead>
              <tbody>
                {bandRows.map(([label, b]) => (
                  <tr key={label}>
                    <td className="strong">{label}</td>
                    <td className="down">${num(b.p5)}</td>
                    <td>${num(b.p25)}</td>
                    <td className="strong">${num(b.p50)}</td>
                    <td>${num(b.p75)}</td>
                    <td className="up">${num(b.p95)}</td>
                    <td>{pct(b.prob_gain_pct, 1)}</td>
                    <td>±{pct(b.expected_move_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine-print">
            Built from {symbol}'s own drift and <Explain term="Volatility" enabled={beginner}>
            volatility</Explain> over the last {period}. Past drift is halved before
            projecting, because a stock that just ran hard is not more likely to keep
            running. Current annual volatility {pct(bands.annualized_volatility_pct)}.
          </p>
        </>
      )}

      <form className="target-check" onSubmit={checkTarget}>
        <label>Odds of reaching</label>
        <div className="target-inputs">
          <span className="prefix">$</span>
          <input type="number" step="0.01" min="0" value={target}
                 placeholder={price ? (price * 1.1).toFixed(2) : "0.00"}
                 onChange={(e) => setTarget(e.target.value)} />
          <select value={targetDays} onChange={(e) => setTargetDays(Number(e.target.value))}>
            <option value={5}>within 1 week</option>
            <option value={21}>within 1 month</option>
            <option value={63}>within 3 months</option>
            <option value={126}>within 6 months</option>
            <option value={252}>within 1 year</option>
          </select>
          <button type="submit" disabled={targetBusy || !target}>
            {targetBusy ? "…" : "Check"}
          </button>
        </div>
        {targetResult && !targetResult.error && (
          <p className="target-result">
            <strong>{pct(targetResult.probability_pct, 1)}</strong> chance {symbol} trades
            at ${num(targetResult.target)} ({targetResult.distance_pct > 0 ? "+" : ""}
            {pct(targetResult.distance_pct)}) at some point in the next{" "}
            {targetResult.days} trading days.
          </p>
        )}
        {targetResult?.error && <p className="error-inline">⚠ {targetResult.error}</p>}
      </form>

      <div className="forecast-grid">
        {trend?.projections && (
          <div className="forecast-card">
            <h3>Trend line</h3>
            <p className={`fit-badge ${trend.fit_quality}`}>
              {trend.fit_quality} fit · r² {num(trend.r_squared, 2)}
            </p>
            <p className="muted small">
              {trend.fit_quality === "weak"
                ? "This stock has not followed a straight line. Treat these numbers as illustration only."
                : "How the price trend extends if the same slope continues."}
            </p>
            <dl className="mini-stats">
              {Object.entries(trend.projections).map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>${num(v)}</dd></div>
              ))}
            </dl>
            <p className="fine-print">
              Trend implies {pct(trend.annualized_drift_pct)}/yr. Price is currently{" "}
              <strong className={trend.deviation_from_trend_pct >= 0 ? "up" : "down"}>
                {trend.deviation_from_trend_pct > 0 ? "+" : ""}
                {pct(trend.deviation_from_trend_pct)}
              </strong>{" "}
              vs its own trend line.
            </p>
          </div>
        )}

        {risk?.sharpe !== undefined && (
          <div className="forecast-card">
            <h3>Risk profile</h3>
            <dl className="mini-stats">
              <div><dt><Explain term="Sharpe" enabled={beginner}>Sharpe</Explain></dt>
                <dd className={risk.sharpe >= 1 ? "up" : risk.sharpe < 0 ? "down" : ""}>
                  {num(risk.sharpe)}</dd></div>
              <div><dt>Sortino</dt><dd>{num(risk.sortino)}</dd></div>
              <div><dt><Explain term="VaR" enabled={beginner}>95% VaR</Explain></dt>
                <dd className="down">{pct(risk.var_95_pct)}</dd></div>
              <div><dt>Worst 5% avg</dt><dd className="down">{pct(risk.cvar_95_pct)}</dd></div>
              <div><dt>Best day</dt><dd className="up">{pct(risk.best_day_pct)}</dd></div>
              <div><dt>Worst day</dt><dd className="down">{pct(risk.worst_day_pct)}</dd></div>
              <div><dt>Up days</dt><dd>{pct(risk.positive_days_pct, 1)}</dd></div>
              <div><dt>Annual vol</dt><dd>{pct(risk.annualized_volatility_pct)}</dd></div>
            </dl>
            {beginner && (
              <p className="fine-print">
                On the worst 1 day in 20, this stock has fallen at least{" "}
                {pct(Math.abs(risk.var_95_pct))}. That is normal behaviour for it,
                not a crash.
              </p>
            )}
          </div>
        )}

        {(levels?.resistance?.length || levels?.support?.length) && (
          <div className="forecast-card">
            <h3><Explain term="Support / resistance" enabled={beginner}>
              Key levels</Explain></h3>
            <ul className="levels">
              {[...(levels.resistance || [])].reverse().map((l) => (
                <li key={`r${l.price}`} className="level res">
                  <span className="level-tag">R</span>
                  <span className="level-price">${num(l.price)}</span>
                  <span className="level-dist up">+{pct(l.distance_pct)}</span>
                  <span className="level-touch">{l.touches}×</span>
                </li>
              ))}
              <li className="level now">
                <span className="level-tag">→</span>
                <span className="level-price">${num(levels.current)}</span>
                <span className="level-dist">now</span>
                <span className="level-touch" />
              </li>
              {(levels.support || []).map((l) => (
                <li key={`s${l.price}`} className="level sup">
                  <span className="level-tag">S</span>
                  <span className="level-price">${num(l.price)}</span>
                  <span className="level-dist down">{pct(l.distance_pct)}</span>
                  <span className="level-touch">{l.touches}×</span>
                </li>
              ))}
            </ul>
            <p className="fine-print">
              Prices where {symbol} has repeatedly turned. "3×" means three separate
              swings stopped near that level.
            </p>
          </div>
        )}
      </div>

      <p className="fine-print disclaimer-inline">
        These are statistical projections from past prices, not predictions. They
        assume the future behaves like the past, which it regularly does not. Not
        financial advice.
      </p>
    </section>
  );
}
