import { useEffect, useMemo, useState } from "react";
import { exportTax, taxReport } from "../api.js";
import { num } from "../format.js";

// Form 8949 and Schedule D, the way the IRS wants them.
//
// RealizedPanel answers "what did I make". This answers "what goes on which
// line", which is a different question with two things in the way: wash sales,
// which disallow a loss you actually took, and box classification, which
// depends on what your broker reported rather than anything we can see.
//
// The wash-sale rows are shown with the purchases that caused them. That is
// deliberate — a number that silently deletes a $5,000 loss needs to show its
// working, or nobody should believe it.

const BASIS_OPTIONS = [
  { value: "true", label: "Reported to IRS (most brokerage stock)" },
  { value: "false", label: "1099-B received, basis not reported" },
  { value: "null", label: "No 1099-B (often crypto)" },
];

function money(v) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return `${n < 0 ? "−" : ""}$${num(Math.abs(n))}`;
}

export default function TaxPanel({ sales, positions, beginner = false }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [basis, setBasis] = useState("true");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const basisValue = basis === "null" ? null : basis === "true";

  useEffect(() => {
    let cancelled = false;
    if (!sales.length) { setData(null); return undefined; }
    taxReport(sales, positions, year, basisValue)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [sales, positions, year, basis]);   // eslint-disable-line react-hooks/exhaustive-deps

  const years = data?.years_available || [];
  const rows = data?.form_8949 || [];
  const d = data?.schedule_d;

  // Group by box, because that is how the form is laid out — each box is a
  // separate page, and totals are per box.
  const byBox = useMemo(() => {
    const out = {};
    rows.forEach((r) => { (out[r.box] ||= []).push(r); });
    return out;
  }, [rows]);

  async function download(format) {
    setBusy(true);
    try {
      await exportTax(sales, positions, year, basisValue, format);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!sales.length) return null;

  return (
    <section className="panel tax-panel">
      <div className="panel-head">
        <h2>🏛 Tax forms</h2>
        <div className="pos-actions">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {(years.length ? years : [String(year)]).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button className="ghost" disabled={busy}
                  onClick={() => download("csv")}>⬇ CSV</button>
          <button className="ghost" disabled={busy}
                  onClick={() => download("xlsx")}>⬇ Excel</button>
        </div>
      </div>

      {beginner && (
        <p className="beginner-note">
          When you sell, the IRS wants every trade listed on{" "}
          <strong>Form 8949</strong>, and the totals summarised on{" "}
          <strong>Schedule D</strong>. This builds both from the trades you've
          recorded. Check it against the 1099-B your broker sends — that form is
          the authority, this is a worksheet.
        </p>
      )}

      <div className="tax-controls">
        <label>
          <span className="k">Cost basis</span>
          <select value={basis} onChange={(e) => setBasis(e.target.value)}>
            {BASIS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <p className="hint">
          Decides which 8949 box these rows belong in. Your 1099-B says which —
          we can't see it.
        </p>
      </div>

      {d && (
        <div className="portfolio-summary">
          <div className="pf-card">
            <span className="k">Short-term</span>
            <span className={`v ${d.short_term.net >= 0 ? "up" : "down"}`}>
              {money(d.short_term.net)}
            </span>
            <span className="sub">taxed as ordinary income</span>
          </div>
          <div className="pf-card">
            <span className="k">Long-term</span>
            <span className={`v ${d.long_term.net >= 0 ? "up" : "down"}`}>
              {money(d.long_term.net)}
            </span>
            <span className="sub">lower rate, held over a year</span>
          </div>
          {/* Zero is its own case: colouring a wash-sale-cancelled year green
              and calling it a gain is just wrong. */}
          <div className={`pf-card big ${d.net_gain_loss > 0 ? "up"
                                       : d.net_gain_loss < 0 ? "down" : ""}`}>
            <span className="k">Net {year}</span>
            <span className="v">{money(d.net_gain_loss)}</span>
            <span className="sub">
              {d.net_gain_loss > 0 ? "reportable gain"
                : d.net_gain_loss < 0 ? "reportable loss"
                : "nets to nothing"}
            </span>
          </div>
          {data.n_wash > 0 && (
            <div className="pf-card warn">
              <span className="k">Wash sales</span>
              <span className="v">{money(data.total_disallowed)}</span>
              <span className="sub">
                disallowed across {data.n_wash} trade{data.n_wash === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </div>
      )}

      {d?.deductible_loss != null && (
        <p className="callout">
          A net capital loss offsets other income only up to{" "}
          <strong>$3,000</strong> a year. You can deduct{" "}
          <strong>{money(d.deductible_loss)}</strong> for {year}
          {d.loss_carryforward
            ? <>, and carry <strong>{money(d.loss_carryforward)}</strong> forward
                to future years — it isn't lost.</>
            : "."}
        </p>
      )}

      {Object.keys(byBox).sort().map((box) => (
        <div key={box}>
          <h3 className="sub-head">
            Box {box}
            <span className="hint">
              {byBox[box][0].term === "short" ? "Part I · short-term"
                                              : "Part II · long-term"}
            </span>
          </h3>
          <div className="table-wrap">
            <table className="data-table tax-table">
              <thead>
                <tr>
                  <th>(a) Description</th>
                  <th>(b) Acquired</th>
                  <th>(c) Sold</th>
                  <th>(d) Proceeds</th>
                  <th>(e) Cost basis</th>
                  <th>(f) Code</th>
                  <th>(g) Adjustment</th>
                  <th>(h) Gain / (loss)</th>
                </tr>
              </thead>
              <tbody>
                {byBox[box].map((r, i) => (
                  <tr key={`${r.description}-${r.date_sold}-${i}`}
                      className={r.gain_loss >= 0 ? "row-up" : "row-down"}>
                    <td className="strong">{r.description}</td>
                    <td className="tiny-cell">{r.date_acquired || "—"}</td>
                    <td className="tiny-cell">{r.date_sold || "—"}</td>
                    <td>{money(r.proceeds)}</td>
                    <td>{money(r.cost_basis)}</td>
                    <td>
                      {r.code
                        ? <span className="term-tag wash" title="Wash sale">
                            {r.code}
                          </span>
                        : "—"}
                    </td>
                    <td>{r.adjustment === "" ? "—" : money(r.adjustment)}</td>
                    <td className={`strong ${r.gain_loss >= 0 ? "up" : "down"}`}>
                      {money(r.gain_loss)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {data?.n_wash > 0 && (
        <>
          <h3 className="sub-head">
            Wash sales
            <span className="hint">
              Sold at a loss, bought back within 30 days — the loss is deferred,
              not deleted.
            </span>
          </h3>
          <ul className="wash-list">
            {rows.filter((r) => r.code === "W").map((r, i) => (
              <li key={`${r.symbol}-${r.date_sold}-${i}`}>
                <span className="strong">{r.symbol}</span>
                <span>
                  sold {r.date_sold} — {money(r.adjustment)} disallowed on{" "}
                  {num(r.wash_shares, 4)} shares
                </span>
                <span className="muted">
                  replaced by{" "}
                  {r.replacements.map((x) => `${num(x.shares, 4)} on ${x.date}`)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
          <p className="fine-print">
            The disallowed amount is added to the cost basis of the shares you
            bought back, so you get the deduction when you finally sell those.
          </p>
        </>
      )}

      {data?.crypto_exempt?.length > 0 && (
        <p className="callout">
          <strong>{data.crypto_exempt.join(", ")}</strong>: the wash-sale rule
          covers stocks and securities. Crypto is currently treated as property,
          so selling at a loss and rebuying immediately keeps the loss. That is a
          real difference, and it may change if the law does.
        </p>
      )}

      {error && <p className="error-inline">⚠ {error}</p>}

      {!rows.length && !error && (
        <p className="muted">No trades closed in {year}.</p>
      )}

      <p className="fine-print">
        Built from the trades in this browser. It can only see what you've
        recorded here, so a sale made elsewhere won't appear, and it assumes
        every lot of a symbol is "substantially identical" for wash-sale
        purposes. Your 1099-B is the authority. Not tax advice.
      </p>
    </section>
  );
}
