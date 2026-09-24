import { useEffect, useRef, useState } from "react";
import { comparePositions, exportComparison, importPositions } from "../api.js";
import { money, num, pct } from "../format.js";
import { csvToPositions, mergePositions } from "../positions.js";
import Explain from "./Explain.jsx";

const PERIODS = [
  ["1mo", "1 month"], ["3mo", "3 months"], ["6mo", "6 months"],
  ["1y", "1 year"], ["2y", "2 years"], ["5y", "5 years"],
];

// "Over the last N months, which of these gained and which lost?"
//
// The key idea is that two different numbers both mean "gain", and showing only
// one of them misleads: a stock can be up 30% over the window while the person
// holding it is down, because of when they bought. Both columns are shown side
// by side, and a lot opened mid-window is flagged rather than credited with the
// whole period's move.
export default function ComparePanel({ positions, setPositions, beginner = false,
                                       onSelect }) {
  const [period, setPeriod] = useState(
    () => localStorage.getItem("sae:compare_period") || "6mo");
  const [benchmark, setBenchmark] = useState(
    () => localStorage.getItem("sae:benchmark") ?? "SPY");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => { localStorage.setItem("sae:compare_period", period); }, [period]);
  useEffect(() => { localStorage.setItem("sae:benchmark", benchmark); }, [benchmark]);

  useEffect(() => {
    let cancelled = false;
    if (!positions.length) { setData(null); return; }
    setLoading(true);
    comparePositions(positions, period, benchmark || null)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [positions, period, benchmark]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const rows = file.name.toLowerCase().endsWith(".csv")
        ? csvToPositions(await file.text())
        : (await importPositions(file)).positions;
      if (!rows?.length) throw new Error("No usable rows in that file.");
      setPositions(mergePositions(positions, rows));
    } catch (err) {
      setError(err.message);
    } finally {
      e.target.value = "";
    }
  }

  const s = data?.summary;
  const bench = data?.benchmark;
  const rows = data?.positions || [];
  const periodLabel = PERIODS.find(([p]) => p === period)?.[1] || period;

  return (
    <section className="panel compare-panel">
      <div className="panel-head">
        <h2>📊 Gain / loss over time</h2>
        <div className="pos-actions">
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map(([p, label]) => <option key={p} value={p}>{label}</option>)}
          </select>
          <input className="bench-input" value={benchmark} placeholder="SPY"
                 title="Benchmark ticker to compare against"
                 onChange={(e) => setBenchmark(e.target.value.toUpperCase())} />
          {rows.length > 0 && (
            <>
              <button className="ghost"
                      onClick={() => exportComparison(positions, period, benchmark, "csv")}>
                ⬇ CSV
              </button>
              <button className="ghost"
                      onClick={() => exportComparison(positions, period, benchmark, "xlsx")}>
                ⬇ Excel
              </button>
            </>
          )}
        </div>
      </div>
      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xlsm" hidden onChange={onFile} />

      {positions.length === 0 && (
        <div className="compare-empty">
          <p>
            Add positions above, or load a holdings file, to see how each one has
            performed over a period you choose.
          </p>
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            ⬆ Load a holdings file (CSV or Excel)
          </button>
        </div>
      )}

      {error && <p className="error-inline">⚠ {error}</p>}
      {loading && !data && <div className="skeleton" style={{ height: 180 }} />}

      {s && (
        <>
          {beginner && (
            <p className="beginner-note">
              Two different things are both called "gain", and they often disagree.
              <strong> Stock over period</strong> is what the share price did in the
              last {periodLabel} — whether or not you owned it.{" "}
              <strong>Your gain</strong> is measured from what you actually paid.
              A stock can be up over the period while you're down on it, simply
              because of when you bought.
            </p>
          )}

          <div className="portfolio-summary">
            <div className="pf-card">
              <span className="k">Worth {periodLabel} ago</span>
              <span className="v">{money(s.start_value)}</span>
              <span className="sub">at today's share counts</span>
            </div>
            <div className="pf-card">
              <span className="k">Worth now</span>
              <span className="v">{money(s.end_value)}</span>
            </div>
            <div className={`pf-card big ${s.period_change >= 0 ? "up" : "down"}`}>
              <span className="k">Change over {periodLabel}</span>
              <span className="v">
                {money(s.period_change, { sign: true })}
              </span>
              <span className="sub">
                {s.period_change_pct >= 0 ? "+" : ""}{pct(s.period_change_pct)}
              </span>
            </div>
            <div className="pf-card">
              <span className="k">Up / down</span>
              <span className="v">{s.gainers} / {s.losers}</span>
              <span className="sub">of {s.n_symbols} holdings</span>
            </div>
          </div>

          {bench && (
            <p className={`bench-line ${bench.verdict}`}>
              {bench.verdict === "ahead" ? "🏆" : bench.verdict === "behind" ? "📉" : "➖"}
              {" "}Your holdings moved <strong>{s.period_change_pct >= 0 ? "+" : ""}
              {pct(s.period_change_pct)}</strong> over {periodLabel};{" "}
              {bench.symbol} moved <strong>{bench.period_change_pct >= 0 ? "+" : ""}
              {pct(bench.period_change_pct)}</strong> — you are{" "}
              <strong>{bench.verdict}</strong> by {pct(Math.abs(bench.excess_pct))}.
            </p>
          )}

          <div className="table-wrap">
            <table className="data-table compare-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Shares</th>
                  <th>Price {periodLabel} ago</th>
                  <th>Price now</th>
                  <th>Stock over period</th>
                  <th>$ on your shares</th>
                  <th><Explain term="Cost basis" enabled={beginner}>You paid</Explain></th>
                  <th>Your gain / loss</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol}>
                    <td>
                      <button className="link-sym" onClick={() => onSelect?.(r.symbol)}>
                        {r.symbol}
                      </button>
                      {!r.held_full_period && (
                        <div className="muted tiny" title={`Bought ${r.opened} — measured from then`}>
                          partial
                        </div>
                      )}
                    </td>
                    <td>{num(r.shares, 4)}</td>
                    <td>{r.period_start_price ? `${money(r.period_start_price)}` : "—"}</td>
                    <td>{r.price ? `${money(r.price)}` : "—"}</td>
                    <td className={`strong ${r.period_change_pct >= 0 ? "up" : "down"}`}>
                      {r.period_change_pct == null ? "—"
                        : `${r.period_change_pct >= 0 ? "+" : ""}${pct(r.period_change_pct)}`}
                    </td>
                    <td className={r.period_change >= 0 ? "up" : "down"}>
                      {r.period_change == null ? "—"
                        : money(r.period_change, { sign: true })}
                    </td>
                    <td>{money(r.avg_cost)}</td>
                    <td className={`strong ${r.pnl >= 0 ? "up" : "down"}`}>
                      {r.pnl == null ? "—"
                        : money(r.pnl, { sign: true })}
                    </td>
                    <td className={r.pnl_pct >= 0 ? "up" : "down"}>
                      {r.pnl_pct == null ? "—"
                        : `${r.pnl_pct >= 0 ? "+" : ""}${pct(r.pnl_pct)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {s.partial_period_holdings > 0 && (
            <p className="fine-print">
              {s.partial_period_holdings} holding
              {s.partial_period_holdings === 1 ? " was" : "s were"} bought partway
              through this window, so "stock over period" for{" "}
              {s.partial_period_holdings === 1 ? "it is" : "those is"} measured from
              the purchase date rather than the full {periodLabel}.
            </p>
          )}

          {s.total_cost > 0 && (
            <p className="fine-print">
              Since you bought: {money(s.total_cost)} invested is now worth{" "}
              {money(s.total_value)} —{" "}
              <strong className={s.total_pnl >= 0 ? "up" : "down"}>
                {money(s.total_pnl, { sign: true })}{" "}
                ({s.total_pnl_pct >= 0 ? "+" : ""}{pct(s.total_pnl_pct)})
              </strong>. That's a different number from the period change above,
              and it's the one that's actually yours.
            </p>
          )}

          {data.not_found?.length > 0 && (
            <p className="error-inline">
              ⚠ Not found, so excluded: {data.not_found.join(", ")}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
