import { useEffect, useState } from "react";
import { portfolioCorrelation } from "../api.js";
import { num, pct } from "../format.js";

const PERIODS = [["6mo", "6 months"], ["1y", "1 year"], ["2y", "2 years"]];

// Colour a correlation cell: red = moves together, blue = moves opposite.
function cellStyle(v) {
  if (v === null || v === undefined) return {};
  const a = Math.min(Math.abs(v), 1);
  const hue = v >= 0 ? 0 : 205;          // red for +, blue for −
  return {
    background: `hsla(${hue}, 70%, 48%, ${0.08 + a * 0.55})`,
    color: a > 0.65 ? "#fff" : "inherit",
  };
}

// The diversification check that actually bites.
//
// Holding NVDA, MSFT and QQQ feels like three positions and behaves like one.
// The panel leads with the plain-English verdict because the matrix alone
// doesn't tell people what to do with it — and it separates the two causes,
// since "everything moves together" and "one position is most of the money"
// need different fixes.
export default function CorrelationPanel({ positions, beginner = false, onSelect }) {
  const [period, setPeriod] = useState("1y");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const symbolCount = new Set(positions.map((p) => p.symbol)).size;

  useEffect(() => {
    let cancelled = false;
    if (symbolCount < 2) { setData(null); return; }
    setLoading(true);
    portfolioCorrelation(positions, period)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [positions, period, symbolCount]);

  if (symbolCount < 2) return null;
  if (loading && !data) return <section className="panel"><h2>🕸 Diversification</h2>
    <div className="skeleton" style={{ height: 200 }} /></section>;
  if (error) return null;
  if (!data) return null;

  const corr = data.correlation || {};
  const div = data.diversification || {};
  if (!corr.available || !div.available) {
    return (
      <section className="panel">
        <h2>🕸 Diversification</h2>
        <p className="muted small">{corr.reason || div.reason || data.reason}</p>
      </section>
    );
  }

  const syms = corr.symbols || [];
  const eff = div.effective_bets;
  const ratio = eff && div.n_symbols ? eff / div.n_symbols : 1;
  const tone = ratio < 0.4 ? "bad" : ratio < 0.7 ? "mixed" : "good";

  return (
    <section className="panel correlation-panel">
      <div className="panel-head">
        <h2>🕸 Diversification</h2>
        <div className="seg small-seg">
          {PERIODS.map(([p, label]) => (
            <button key={p} className={period === p ? "on" : ""}
                    onClick={() => setPeriod(p)}>{label}</button>
          ))}
        </div>
      </div>

      <div className={`verdict-box ${tone}`}>
        <span className="verdict-tag">
          {num(eff, 2)} of {div.n_symbols} bets
        </span>
        <p>{data.verdict}</p>
      </div>

      {beginner && (
        <p className="beginner-note">
          Owning more tickers isn't the same as being diversified. If your
          holdings all rise and fall together, a bad day hits all of them at
          once — so five such stocks behave like one. The number above says how
          many genuinely <em>independent</em> bets you actually have.
        </p>
      )}

      <div className="portfolio-summary">
        <div className="pf-card">
          <span className="k">Holdings</span>
          <span className="v">{div.n_symbols}</span>
        </div>
        <div className={`pf-card big ${tone === "bad" ? "down" : tone === "good" ? "up" : ""}`}>
          <span className="k">Independent bets</span>
          <span className="v">{num(eff, 2)}</span>
          <span className="sub">after correlation &amp; sizing</span>
        </div>
        <div className="pf-card">
          <span className="k">Avg correlation</span>
          <span className="v">{num(corr.avg_correlation, 2)}</span>
          <span className="sub">1.0 = identical</span>
        </div>
        <div className="pf-card">
          <span className="k">Volatility saved</span>
          <span className="v">{pct(div.diversification_benefit_pct)}</span>
          <span className="sub">
            {pct(div.portfolio_volatility_pct)} vs {pct(div.undiversified_volatility_pct)}
          </span>
        </div>
      </div>

      {div.limited_by === "concentration" && (
        <p className="concentration-warn">
          ⚠ The limit here is <strong>position sizing</strong>, not correlation —
          your largest holding is {pct(div.top_weight_pct, 0)} of the money.
          Sizing alone would give you {num(div.weight_effective_bets, 2)} bets.
        </p>
      )}
      {div.limited_by === "correlation" && (
        <p className="concentration-warn">
          ⚠ The limit here is <strong>correlation</strong> — your positions are
          sized evenly ({num(div.weight_effective_bets, 2)} bets by size alone)
          but they move together.
        </p>
      )}

      <h3 className="sub-head">
        How each pair moves together
        <span className="hint">
          Red = rise and fall together. Blue = move opposite. Near 0 = unrelated.
        </span>
      </h3>
      <div className="table-wrap">
        <table className="data-table corr-matrix">
          <thead>
            <tr>
              <th />
              {syms.map((s) => <th key={s}>{s}</th>)}
            </tr>
          </thead>
          <tbody>
            {syms.map((a) => (
              <tr key={a}>
                <th scope="row">
                  <button className="link-sym" onClick={() => onSelect?.(a)}>{a}</button>
                </th>
                {syms.map((b) => {
                  const v = corr.matrix?.[a]?.[b];
                  return (
                    <td key={b} style={cellStyle(v)} className="corr-cell"
                        title={`${a} vs ${b}: ${v}`}>
                      {v == null ? "—" : v.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {corr.high_pairs?.length > 0 && (
        <p className="fine-print">
          <strong>Nearly interchangeable:</strong>{" "}
          {corr.high_pairs.map((p) => `${p.a}/${p.b} (${p.correlation.toFixed(2)})`)
            .join(", ")}. Holding both gives you far less diversification than
          the position count suggests.
        </p>
      )}

      <p className="fine-print">
        Measured on daily moves over {corr.n_days} shared trading days
        ({corr.start} → {corr.end}). Correlation changes over time and tends to
        rise sharply in a crash — precisely when you were counting on it not to.
      </p>
    </section>
  );
}
