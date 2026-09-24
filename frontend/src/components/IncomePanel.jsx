import { useEffect, useState } from "react";
import { portfolioIncome } from "../api.js";
import { money, num, pct } from "../format.js";
import Explain from "./Explain.jsx";

// Dividend income from what you actually hold.
//
// The column that earns this panel its space is YIELD ON COST: the dividend
// measured against what you paid, not today's price. Every free tool shows the
// current yield; yours is usually the more interesting number and nobody
// displays it.
export default function IncomePanel({ positions, beginner = false, onSelect }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!positions.length) { setData(null); return; }
    setLoading(true);
    portfolioIncome(positions)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [positions]);

  if (!positions.length) return null;
  if (loading && !data) return <section className="panel"><h2>💰 Dividend income</h2>
    <div className="skeleton" style={{ height: 160 }} /></section>;
  if (error) return null;
  if (!data) return null;

  const s = data.summary;
  const payers = data.positions.filter((r) => r.annual_income);

  if (!payers.length) {
    return (
      <section className="panel">
        <h2>💰 Dividend income</h2>
        <p className="muted small">
          None of your holdings currently pay a dividend. That's normal for
          growth names — they reinvest instead of paying out.
        </p>
      </section>
    );
  }

  return (
    <section className="panel income-panel">
      <h2>💰 Dividend income</h2>

      {beginner && (
        <p className="beginner-note">
          A <Explain term="Dividend">dividend</Explain> is cash a company sends
          you just for holding the shares — you don't have to sell anything.
          Two different "yield" numbers matter: <strong>yield on cost</strong> is
          the cash measured against what <em>you</em> paid, and it's the one that's
          really yours. <strong>Current yield</strong> is what a new buyer would
          get today.
        </p>
      )}

      <div className="portfolio-summary">
        <div className="pf-card big up">
          <span className="k">Income per year</span>
          <span className="v">{money(s.annual_income)}</span>
          <span className="sub">{money(s.monthly_income)}/month</span>
        </div>
        <div className="pf-card">
          <span className="k">Yield on cost</span>
          <span className="v">{pct(s.yield_on_cost_pct)}</span>
          <span className="sub">on {money(s.total_cost)} invested</span>
        </div>
        <div className="pf-card">
          <span className="k">Current yield</span>
          <span className="v">{pct(s.current_yield_pct)}</span>
          <span className="sub">on today's value</span>
        </div>
        <div className="pf-card">
          <span className="k">Payers</span>
          <span className="v">{s.n_payers} / {s.n_holdings}</span>
          {s.biggest_payer && (
            <span className="sub">{s.biggest_payer} is {pct(s.top_payer_share_pct, 0)}</span>
          )}
        </div>
      </div>

      {s.top_payer_share_pct > 60 && s.n_payers > 1 && (
        <p className="concentration-warn">
          ⚠ {s.biggest_payer} is {pct(s.top_payer_share_pct, 0)} of your dividend
          income. One cut there takes most of it.
        </p>
      )}
      {s.stretched_payers?.length > 0 && (
        <p className="concentration-warn">
          ⚠ Paying out more than 80% of earnings: {s.stretched_payers.join(", ")}.
          A high payout ratio doesn't predict a cut, but it's where cuts come from.
        </p>
      )}

      <div className="table-wrap">
        <table className="data-table income-table">
          <thead>
            <tr>
              <th>Symbol</th><th>Shares</th><th>Per share</th>
              <th>Income / yr</th><th>Per quarter</th>
              <th><Explain term="Dividend" enabled={beginner}>Yield on cost</Explain></th>
              <th>Current yield</th><th>Payout</th><th>Next ex-date</th>
            </tr>
          </thead>
          <tbody>
            {payers.map((r) => (
              <tr key={r.symbol}>
                <td>
                  <button className="link-sym" onClick={() => onSelect?.(r.symbol)}>
                    {r.symbol}
                  </button>
                </td>
                <td>{num(r.shares, 4)}</td>
                <td>{money(r.rate)}</td>
                <td className="strong up">{money(r.annual_income)}</td>
                <td>{money(r.quarterly_income)}</td>
                <td className="strong">{pct(r.yield_on_cost_pct)}</td>
                <td className="muted">{pct(r.current_yield_pct)}</td>
                <td className={r.stretched ? "warn" : ""}>
                  {r.payout_ratio_pct == null ? "—" : pct(r.payout_ratio_pct, 0)}
                </td>
                <td>
                  {r.next_ex?.date || "—"}
                  {r.next_ex?.estimated && <span className="muted tiny"> est.</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.upcoming_ex_dates?.length > 0 && (
        <>
          <h3 className="sub-head">
            Next payments
            <span className="hint">
              Buy on or after the ex-date and you miss that payment.
            </span>
          </h3>
          <ul className="exdiv-list">
            {data.upcoming_ex_dates.slice(0, 5).map((u) => (
              <li key={u.symbol}>
                <span className="strong">{u.symbol}</span>
                <span>{u.ex_div_date}</span>
                <span className="muted">
                  {u.days_away != null ? `in ${u.days_away}d` : ""}
                </span>
                <span className="up">≈ {money(u.estimated_payment)}</span>
                {u.estimated && (
                  <span className="muted tiny" title={`Last ex-date was ${u.last_ex_date}`}>
                    projected
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="fine-print">
        Projected from each company's declared rate, assuming quarterly payments
        and no change. Dividends get cut — this is an estimate, not income you're
        owed. Dates marked "projected" are rolled forward from the last ex-date,
        because the data source reports the most recent one rather than the next.
      </p>
    </section>
  );
}
