import { useEffect, useState } from "react";
import { holdings as fetchHoldings } from "../api.js";
import { big, num, pct } from "../format.js";
import Explain from "./Explain.jsx";

// What an ETF / index fund actually owns.
//
// Buying SPY is buying ~500 companies, and the concentration inside the wrapper
// is the thing people miss — a "diversified" S&P fund is currently a third
// technology, with the top 10 names alone near 40%. Renders nothing at all for
// ordinary stocks.
export default function HoldingsPanel({ symbol, beginner = false, onSelect }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetchHoldings(symbol)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol]);

  if (loading) return <section className="panel"><h2>🧺 Fund composition</h2>
    <div className="skeleton" style={{ height: 180 }} /></section>;
  if (error) return null;           // a failed lookup shouldn't add noise
  if (!data || !data.is_fund) return null;

  const { holdings: rows = [], sectors = [], asset_classes: assets = {} } = data;
  const maxSector = Math.max(...sectors.map((s) => s.weight_pct), 1);
  const topWeight = data.top_n_weight_pct;

  return (
    <section className="panel holdings-panel">
      <h2>🧺 What's inside {data.symbol}</h2>

      <p className="holdings-lede">
        {data.name} is {data.overview?.legalType
          ? <>an <Explain term="ETF" enabled={beginner}>{data.overview.legalType.toLowerCase()}</Explain></>
          : <>an <Explain term="ETF" enabled={beginner}>exchange-traded fund</Explain></>}
        {data.overview?.family ? ` run by ${data.overview.family}` : ""}
        {data.overview?.categoryName ? ` in the ${data.overview.categoryName} category` : ""}.
        {" "}One share buys a slice of every company below.
      </p>

      <div className="fund-stats">
        {data.expense_ratio_pct != null && (
          <div className="fund-stat">
            <span className="k"><Explain term="Expense ratio" enabled={beginner}>
              Expense ratio</Explain></span>
            <span className="v">{num(data.expense_ratio_pct, 3)}%</span>
            <span className="sub">
              ${num((data.expense_ratio_pct / 100) * 10000, 2)} a year per $10,000
            </span>
          </div>
        )}
        {data.total_assets != null && (
          <div className="fund-stat">
            <span className="k">Fund size</span>
            <span className="v">${big(data.total_assets)}</span>
          </div>
        )}
        {data.ytd_return_pct != null && (
          <div className="fund-stat">
            <span className="k">Return YTD</span>
            <span className={`v ${data.ytd_return_pct >= 0 ? "up" : "down"}`}>
              {data.ytd_return_pct > 0 ? "+" : ""}{pct(data.ytd_return_pct)}
            </span>
          </div>
        )}
        {topWeight != null && (
          <div className="fund-stat">
            <span className="k"><Explain term="Concentration" enabled={beginner}>
              Top {rows.length} weight</Explain></span>
            <span className={`v ${topWeight > 40 ? "warn" : ""}`}>{pct(topWeight)}</span>
            <span className="sub">of the whole fund</span>
          </div>
        )}
      </div>

      {topWeight > 35 && (
        <p className="concentration-warn">
          ⚠ The largest {rows.length} holdings are {pct(topWeight)} of this fund.
          It is less diversified than the number of companies in it suggests.
        </p>
      )}

      {rows.length > 0 && (
        <>
          <h3 className="sub-head">Top holdings</h3>
          <div className="table-wrap">
            <table className="data-table holdings-table">
              <thead>
                <tr><th>#</th><th>Symbol</th><th>Company</th><th>Weight</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((h, i) => (
                  <tr key={h.symbol}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      <button className="link-sym" onClick={() => onSelect?.(h.symbol)}
                              title={`Analyse ${h.symbol}`}>{h.symbol}</button>
                    </td>
                    <td>{h.name}</td>
                    <td className="strong">{pct(h.weight_pct, 2)}</td>
                    <td className="weight-cell">
                      <span className="weight-bar"
                            style={{ width: `${Math.min((h.weight_pct / (rows[0]?.weight_pct || 1)) * 100, 100)}%` }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine-print">
            Click a symbol to analyse it on its own. Funds hold far more than the
            names listed here — these are the largest positions, which drive most
            of the movement.
          </p>
        </>
      )}

      {sectors.length > 0 && (
        <>
          <h3 className="sub-head">Sector breakdown</h3>
          <div className="sector-bars">
            {sectors.map((s) => (
              <div key={s.sector} className="sector-row">
                <span className="sector-name">{s.sector}</span>
                <span className="sector-track">
                  <span className="sector-fill"
                        style={{ width: `${(s.weight_pct / maxSector) * 100}%` }} />
                </span>
                <span className="sector-val">{pct(s.weight_pct)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {assets.stockPosition != null && (
        <p className="fine-print">
          Asset mix: {pct(assets.stockPosition)} shares
          {assets.bondPosition ? `, ${pct(assets.bondPosition)} bonds` : ""}
          {assets.cashPosition ? `, ${pct(assets.cashPosition)} cash` : ""}.
        </p>
      )}

      {data.description && (
        <details className="fund-desc">
          <summary>Fund objective</summary>
          <p>{data.description}</p>
        </details>
      )}
    </section>
  );
}
