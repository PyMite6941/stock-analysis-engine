import { useEffect, useState } from "react";
import { portfolioRisk } from "../api.js";
import { num, pct } from "../format.js";
import Explain from "./Explain.jsx";

// The book as one object.
//
// Every other panel measures one symbol. That is the wrong unit for the only
// question that changes behaviour — what should I buy next? — because the risk
// of adding NVDA depends entirely on what you already own.
//
// The uncomfortable number here is "effective positions": ten holdings where
// one is 80% behaves like one holding. The second is the cluster list, which
// names the holdings that will all be red on the same morning.

function bar(pctValue) {
  return { width: `${Math.max(1, Math.min(100, pctValue))}%` };
}

export default function RiskPanel({ positions, period = "1y",
                                    beginner = false, onSelect }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!positions.length) { setData(null); return undefined; }
    portfolioRisk(positions, period)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) { setError(e.message); setData(null); } });
    return () => { cancelled = true; };
  }, [positions, period]);

  if (!positions.length) return null;
  if (error) {
    return (
      <section className="panel">
        <h2>⚖ Portfolio risk</h2>
        <p className="error-inline">⚠ {error}</p>
      </section>
    );
  }
  if (!data) return null;

  const c = data.concentration || {};
  const p = data.portfolio || {};
  const clusters = data.clusters || [];
  const weights = Object.entries(c.weights_pct || {});

  return (
    <section className="panel risk-panel">
      <div className="panel-head">
        <h2>⚖ Portfolio risk</h2>
        <span className="hint">{data.period}</span>
      </div>

      {beginner && (
        <p className="beginner-note">
          Owning ten things isn't the same as being spread across ten things. If
          one holding is most of your money, or several move together, your
          portfolio behaves like far fewer bets than it looks like. That's what
          this measures.
        </p>
      )}

      {data.verdict && <p className="verdict">{data.verdict}</p>}

      <div className="portfolio-summary">
        {c.available && (
          <>
            <div className={`pf-card ${c.concentrated ? "warn" : ""}`}>
              <span className="k">
                <Explain term="Concentration" enabled={beginner}>
                  Largest holding
                </Explain>
              </span>
              <span className="v">{pct(c.largest.weight_pct, 1)}</span>
              <span className="sub">{c.largest.symbol}</span>
            </div>
            <div className="pf-card">
              <span className="k">Effective positions</span>
              <span className="v">{num(c.effective_positions, 1)}</span>
              <span className="sub">from {c.n_positions} holdings</span>
            </div>
          </>
        )}
        {p.available && (
          <>
            <div className="pf-card">
              <span className="k">
                <Explain term="Volatility" enabled={beginner}>Volatility</Explain>
              </span>
              <span className="v">{pct(p.annual_volatility_pct, 1)}</span>
              <span className="sub">annualised, whole book</span>
            </div>
            <div className="pf-card">
              <span className="k">
                <Explain term="Sharpe" enabled={beginner}>Sharpe</Explain>
              </span>
              <span className={`v ${p.sharpe >= 1 ? "up" : ""}`}>
                {p.sharpe == null ? "—" : num(p.sharpe, 2)}
              </span>
              <span className="sub">return per unit of risk</span>
            </div>
            <div className="pf-card">
              <span className="k">
                <Explain term="VaR" enabled={beginner}>Worst day in 20</Explain>
              </span>
              <span className="v down">{pct(p.var_95_pct, 2)}</span>
              <span className="sub">
                average beyond that: {pct(p.cvar_95_pct, 2)}
              </span>
            </div>
            <div className="pf-card">
              <span className="k">
                <Explain term="Max drawdown" enabled={beginner}>
                  Max drawdown
                </Explain>
              </span>
              <span className="v down">{pct(p.max_drawdown_pct, 1)}</span>
              <span className="sub">peak to trough, this window</span>
            </div>
          </>
        )}
      </div>

      {weights.length > 0 && (
        <>
          <h3 className="sub-head">
            Where the money is
            <span className="hint">share of market value, not cost</span>
          </h3>
          <ul className="weight-list">
            {weights.map(([sym, w]) => (
              <li key={sym}>
                <button className="link-sym" onClick={() => onSelect?.(sym)}>
                  {sym}
                </button>
                <span className="weight-track">
                  <span className={`weight-fill ${w >= 25 ? "hot" : ""}`}
                        style={bar(w)} />
                </span>
                <span className="weight-val">{pct(w, 1)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {clusters.length > 0 && (
        <>
          <h3 className="sub-head">
            These move together
            <span className="hint">
              correlated above 0.75 — closer to one position than several
            </span>
          </h3>
          <ul className="cluster-list">
            {clusters.map((group) => (
              <li key={group.join("-")}>
                {group.map((s) => (
                  <button key={s} className="link-sym"
                          onClick={() => onSelect?.(s)}>{s}</button>
                ))}
                <span className="muted">
                  {group.length} holdings, roughly one bet
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {data.n_unpriced > 0 && (
        <p className="muted tiny">
          {data.n_unpriced} holding{data.n_unpriced === 1 ? "" : "s"} had no
          price and {data.n_unpriced === 1 ? "was" : "were"} left out of these
          figures rather than counted as worthless.
        </p>
      )}

      <p className="fine-print">
        Measured on daily returns over {data.period} of overlapping history.
        Correlations move — they tend to rise in a crash, which is exactly when
        diversification is supposed to help. Past behaviour, not a forecast.
      </p>
    </section>
  );
}
