import { useEffect, useState } from "react";
import { exportRealized, realizedGains, saveBlob } from "../api.js";
import { money, num, pct } from "../format.js";
import { removeSale, salesToCsv } from "../sales.js";
import Explain from "./Explain.jsx";

// Closed trades: what you actually banked, split by holding period.
//
// The short/long split is the point. In the US, holding more than a year moves
// a gain into a much lower tax bracket, so "how close was I" is a real question
// — hence the countdown on open lots that are nearly there.
export default function RealizedPanel({ sales, setSales, positions,
                                        beginner = false, onSelect }) {
  const [data, setData] = useState(null);
  const [year, setYear] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!sales.length && !positions.length) { setData(null); return; }
    realizedGains(sales, positions, year)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [sales, positions, year]);

  const soon = data?.approaching_long_term || [];

  // Nothing sold yet, but flag any lot about to turn long-term — that's the
  // one genuinely actionable thing before a first sale exists.
  if (!sales.length) {
    if (!soon.length) return null;
    return (
      <section className="panel">
        <h2>📆 Approaching long-term</h2>
        <ul className="lt-list">
          {soon.map((l) => (
            <li key={l.id}>
              <span className="strong">{l.symbol}</span>
              <span>{num(l.shares, 4)} shares bought {l.opened}</span>
              <span className="up strong">{l.days_to_long_term} days</span>
              <span className="muted">until long-term</span>
            </li>
          ))}
        </ul>
        <p className="fine-print">
          In the US, gains on holdings kept more than a year are usually taxed at
          a lower rate. Informational only — not tax advice, and your situation
          may differ.
        </p>
      </section>
    );
  }

  const s = data?.summary;
  const years = data?.by_year || [];

  return (
    <section className="panel realized-panel">
      <div className="panel-head">
        <h2>🧾 Realised gains</h2>
        <div className="pos-actions">
          {years.length > 1 && (
            <select value={year ?? ""}
                    onChange={(e) => setYear(e.target.value ? Number(e.target.value) : null)}>
              <option value="">All years</option>
              {years.map((y) => <option key={y.year} value={y.year}>{y.year}</option>)}
            </select>
          )}
          <button className="ghost" onClick={() => exportRealized(sales, "csv")
            .catch(() => saveBlob(new Blob([salesToCsv(sales)], { type: "text/csv" }),
                                  "realized_gains.csv"))}>⬇ CSV</button>
          <button className="ghost" onClick={() => exportRealized(sales, "xlsx")}>
            ⬇ Excel
          </button>
        </div>
      </div>

      {beginner && (
        <p className="beginner-note">
          A gain only becomes <strong>real</strong> when you sell — until then
          it's on paper and can vanish. These are your closed trades. The
          short/long split matters because, in the US, holding something more
          than a year is usually taxed more kindly.
        </p>
      )}

      {s && (
        <div className="portfolio-summary">
          <div className={`pf-card big ${s.total_pnl >= 0 ? "up" : "down"}`}>
            <span className="k">Realised {year ? `in ${year}` : "total"}</span>
            <span className="v">
              {money(s.total_pnl, { sign: true })}
            </span>
            <span className="sub">
              on {money(s.total_cost)} ({s.total_pnl_pct >= 0 ? "+" : ""}
              {pct(s.total_pnl_pct)})
            </span>
          </div>
          <div className="pf-card">
            <span className="k">Short-term</span>
            <span className={`v ${s.short_term_pnl >= 0 ? "up" : "down"}`}>
              {money(s.short_term_pnl, { sign: true })}
            </span>
            <span className="sub">{s.n_short_term} trades, under 1 year</span>
          </div>
          <div className="pf-card">
            <span className="k">Long-term</span>
            <span className={`v ${s.long_term_pnl >= 0 ? "up" : "down"}`}>
              {money(s.long_term_pnl, { sign: true })}
            </span>
            <span className="sub">{s.n_long_term} trades, over 1 year</span>
          </div>
          <div className="pf-card">
            <span className="k">Win rate</span>
            <span className="v">{pct(s.win_rate_pct, 0)}</span>
            <span className="sub">{s.wins}W / {s.losses}L</span>
          </div>
          {s.n_intraday > 0 && (
            <div className="pf-card">
              <span className="k">Day trades</span>
              <span className={`v ${s.intraday_pnl >= 0 ? "up" : "down"}`}>
                {money(s.intraday_pnl, { sign: true })}
              </span>
              <span className="sub">{s.n_intraday} same-day round trips</span>
            </div>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table realized-table">
          <thead>
            <tr>
              <th>Symbol</th><th>Shares</th><th>Bought</th><th>Sold</th>
              <th>Held</th><th>Term</th><th>Paid</th><th>Sold at</th>
              <th>Gain / loss</th><th>%</th><th />
            </tr>
          </thead>
          <tbody>
            {(data?.sales || []).map((r) => (
              <tr key={r.id} className={r.pnl >= 0 ? "row-up" : "row-down"}>
                <td>
                  <button className="link-sym" onClick={() => onSelect?.(r.symbol)}>
                    {r.symbol}
                  </button>
                </td>
                <td>{num(r.shares, 4)}</td>
                <td className="tiny-cell">{r.opened || "—"}</td>
                <td className="tiny-cell">{r.closed || "—"}</td>
                <td>
                  {r.holding_label || "—"}
                  {r.intraday && <span className="tag intraday">day</span>}
                </td>
                <td>
                  <span className={`term-tag ${r.term}`}>{r.term}</span>
                </td>
                <td>{money(r.cost_basis)}</td>
                <td>{money(r.exit_price)}</td>
                <td className={`strong ${r.pnl >= 0 ? "up" : "down"}`}>
                  {money(r.pnl, { sign: true })}
                </td>
                <td className={r.pnl_pct >= 0 ? "up" : "down"}>
                  {r.pnl_pct == null ? "—"
                    : `${r.pnl_pct >= 0 ? "+" : ""}${pct(r.pnl_pct)}`}
                </td>
                <td className="row-actions">
                  <button className="icon danger" title="Delete this record"
                          onClick={() => setSales(removeSale(sales, r.id))}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {years.length > 1 && (
        <>
          <h3 className="sub-head">By tax year</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Year</th><th>Trades</th><th>Short-term</th>
                  <th>Long-term</th><th>Total</th><th>Win rate</th></tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.year}>
                    <td className="strong">{y.year}</td>
                    <td>{y.n_sales}</td>
                    <td className={y.short_term_pnl >= 0 ? "up" : "down"}>
                      {money(y.short_term_pnl)}
                    </td>
                    <td className={y.long_term_pnl >= 0 ? "up" : "down"}>
                      {money(y.long_term_pnl)}
                    </td>
                    <td className={`strong ${y.total_pnl >= 0 ? "up" : "down"}`}>
                      {money(y.total_pnl)}
                    </td>
                    <td>{pct(y.win_rate_pct, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {soon.length > 0 && (
        <>
          <h3 className="sub-head">
            Open lots approaching long-term
            <span className="hint">Selling after this date is usually taxed less.</span>
          </h3>
          <ul className="lt-list">
            {soon.map((l) => (
              <li key={l.id}>
                <span className="strong">{l.symbol}</span>
                <span>{num(l.shares, 4)} shares from {l.opened}</span>
                <span className="up strong">{l.days_to_long_term} days</span>
                <span className="muted">to go</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && <p className="error-inline">⚠ {error}</p>}

      <p className="fine-print">
        A personal record kept in this browser, not a tax document — your broker's
        1099 is the authority. These are raw gains; wash-sale adjustments and
        the Form 8949 boxes are in the tax panel below.{" "}
        <Explain term="Cost basis" enabled={beginner}>Cost basis</Explain>{" "}
        comes from the lots you sold against. Not tax advice.
      </p>
    </section>
  );
}
