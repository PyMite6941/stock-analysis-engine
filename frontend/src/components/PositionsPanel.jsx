import { useEffect, useRef, useState } from "react";
import { exportPositions, importPositions, portfolio as fetchPortfolio,
         saveBlob, sellPosition } from "../api.js";
import { num, pct } from "../format.js";
import {
  addPosition, csvToPositions, loadPositions, mergePositions, positionsToCsv,
  removePosition, replacePositions, updatePosition,
} from "../positions.js";
import Explain from "./Explain.jsx";
import PhotoImport from "./PhotoImport.jsx";

const BLANK = { symbol: "", shares: "", cost_basis: "", opened: "",
                openedTime: "", note: "" };
const SELL_BLANK = { symbol: "", shares: "", price: "", date: "", time: "",
                     method: "fifo" };

// Combine the date and optional time inputs into one stored stamp.
// Day traders open and close inside a session, so the clock time is what
// makes the holding period meaningful at all.
function stamp(date, time) {
  if (!date) return null;
  return time ? `${date} ${time}` : date;
}

// Split a stored stamp back into the two inputs.
function unstamp(value) {
  const s = String(value || "");
  return { date: s.slice(0, 10), time: s.length > 10 ? s.slice(11, 16) : "" };
}

// "I bought 400 NVDA at $178.50" — entered here, kept in localStorage, marked to
// market against live quotes, and exportable as CSV/XLSX.
//
// The list never leaves the browser unless the user exports it, which is also
// why the export button is prominent rather than tucked away: clearing site data
// is the one way to lose it.
export default function PositionsPanel({ beginner = false, livePrices = {},
                                         onSymbolsChange, onSelect, positions,
                                         setPositions, onSold }) {
  const [valued, setValued] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sell, setSell] = useState(null);          // SELL_BLANK when open
  const [sellBusy, setSellBusy] = useState(false);
  const fileRef = useRef(null);

  // Re-price whenever the list changes. The server does the maths so the numbers
  // here match the CSV/XLSX export and whatever the AI analyst is told.
  useEffect(() => {
    let cancelled = false;
    if (!positions.length) { setValued(null); return; }
    setBusy(true);
    fetchPortfolio(positions)
      .then((d) => { if (!cancelled) { setValued(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [positions]);

  useEffect(() => { onSymbolsChange?.([...new Set(positions.map((p) => p.symbol))]); },
    [positions]); // eslint-disable-line react-hooks/exhaustive-deps

  function flash(msg) {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  }

  function submit(e) {
    e.preventDefault();
    const entry = {
      symbol: form.symbol.trim().toUpperCase(),
      shares: Number(form.shares),
      cost_basis: Number(form.cost_basis),
      opened: stamp(form.opened, form.openedTime),
      note: form.note?.trim() || null,
    };
    if (!entry.symbol) return setError("Enter a ticker symbol.");
    if (!Number.isFinite(entry.shares) || entry.shares === 0)
      return setError("Enter how many shares you bought.");
    if (!Number.isFinite(entry.cost_basis) || entry.cost_basis <= 0)
      return setError("Enter the price you paid per share.");

    setError(null);
    setPositions(editing ? updatePosition(positions, editing, entry)
                         : addPosition(positions, entry));
    flash(editing ? `Updated ${entry.symbol}.`
                  : `Added ${num(entry.shares, 4)} ${entry.symbol} at $${num(entry.cost_basis)}.`);
    setForm(BLANK);
    setEditing(null);
  }

  function startEdit(row) {
    setEditing(row.id);
    const when = unstamp(row.opened);
    setForm({
      symbol: row.symbol, shares: String(row.shares),
      cost_basis: String(row.cost_basis), opened: when.date,
      openedTime: when.time, note: row.note || "",
    });
    setError(null);
  }

  function remove(row) {
    setPositions(removePosition(positions, row.id));
    if (editing === row.id) { setEditing(null); setForm(BLANK); }
  }

  function startSell(row) {
    const now = new Date();
    setError(null);
    setSell({
      ...SELL_BLANK,
      symbol: row.symbol,
      shares: String(row.shares),
      price: row.price ? String(row.price) : "",
      date: now.toISOString().slice(0, 10),
      // Prefill the time only when the lot itself was timed — otherwise the
      // sale looks precise when the buy wasn't.
      time: row.opened && String(row.opened).length > 10
        ? now.toTimeString().slice(0, 5) : "",
    });
  }

  async function confirmSell(e) {
    e.preventDefault();
    const shares = Number(sell.shares);
    const price = Number(sell.price);
    if (!Number.isFinite(shares) || shares <= 0) return setError("How many shares?");
    if (!Number.isFinite(price) || price <= 0) return setError("Sold at what price?");

    setSellBusy(true);
    setError(null);
    try {
      const res = await sellPosition({
        positions,
        symbol: sell.symbol,
        shares,
        price,
        soldOn: stamp(sell.date, sell.time),
        method: sell.method,
      });
      // The server returns both the realised rows and the reduced lot list, so
      // the two stores stay consistent with a single round trip.
      setPositions(replacePositions(res.remaining_lots));
      onSold?.(res.realized);
      const total = res.realized.reduce((a, r) => a + r.pnl, 0);
      flash(`Sold ${num(shares, 4)} ${sell.symbol} — realised ${total >= 0 ? "+" : "−"}$${num(Math.abs(total))}.`);
      if (res.unmatched > 0) {
        setError(`Only ${num(shares - res.unmatched, 4)} shares were held; ${num(res.unmatched, 4)} could not be matched.`);
      }
      setSell(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSellBusy(false);
    }
  }

  async function doExport(format) {
    setError(null);
    try {
      await exportPositions(positions, format);
    } catch (e) {
      // Offline or backend down — the list is local data, so fall back to a
      // locally generated CSV rather than failing the save outright.
      if (format === "csv") {
        saveBlob(new Blob([positionsToCsv(positions)], { type: "text/csv" }),
                 "holdings.csv");
        flash("Saved locally (backend unreachable, so no live prices included).");
      } else {
        setError(`${e.message} — try CSV instead.`);
      }
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      let rows;
      if (file.name.toLowerCase().endsWith(".csv")) {
        rows = csvToPositions(await file.text());      // parse locally, no upload
      } else {
        rows = (await importPositions(file)).positions; // XLSX needs the backend
      }
      if (!rows?.length) throw new Error("No usable rows in that file.");
      setPositions(mergePositions(positions, rows));
      flash(`Imported ${rows.length} position${rows.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      e.target.value = "";   // let the same file be picked again
    }
  }

  const rows = valued?.positions || [];
  const summary = valued?.summary;
  const bySymbol = valued?.by_symbol || [];

  // Overlay live ticks between server refreshes so P/L doesn't sit stale.
  const live = (row) => {
    const tick = livePrices[row.symbol];
    if (!tick?.price || !row.cost) return row;
    const mv = row.shares * tick.price;
    return { ...row, price: tick.price, market_value: mv, pnl: mv - row.cost,
             pnl_pct: (mv - row.cost) / row.cost * 100, _live: true };
  };
  const liveRows = rows.map(live);
  const liveTotal = liveRows.reduce((a, r) => a + (r.market_value || 0), 0);
  const liveCost = liveRows.reduce((a, r) => a + (r.cost || 0), 0);
  const livePnl = liveTotal - liveCost;

  return (
    <section className="panel positions-panel">
      <div className="panel-head">
        <h2>💼 My positions</h2>
        {positions.length > 0 && (
          <div className="pos-actions">
            <button className="ghost" onClick={() => doExport("csv")}>⬇ CSV</button>
            <button className="ghost" onClick={() => doExport("xlsx")}>⬇ Excel</button>
            <button className="ghost" onClick={() => fileRef.current?.click()}>⬆ Import</button>
          </div>
        )}
      </div>
      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xlsm" hidden onChange={onFile} />

      {beginner && positions.length === 0 && (
        <p className="beginner-note">
          Record what you actually bought and this page will track it for you:
          what it cost, what it's worth now, and whether you're up or down. Nothing
          here is sent anywhere — it's saved in this browser, and you can download
          it as a spreadsheet any time.
        </p>
      )}

      {summary && liveCost > 0 && (
        <div className="portfolio-summary">
          <div className="pf-card">
            <span className="k">Invested</span>
            <span className="v">${num(liveCost)}</span>
          </div>
          <div className="pf-card">
            <span className="k">Worth now</span>
            <span className="v">${num(liveTotal)}</span>
          </div>
          <div className={`pf-card big ${livePnl >= 0 ? "up" : "down"}`}>
            <span className="k"><Explain term="Unrealised P/L" enabled={beginner}>
              {livePnl >= 0 ? "Total gain" : "Total loss"}</Explain></span>
            <span className="v">
              {livePnl >= 0 ? "+" : "−"}${num(Math.abs(livePnl))}
            </span>
            <span className="sub">
              {livePnl >= 0 ? "+" : ""}{pct(liveCost ? (livePnl / liveCost) * 100 : 0)}
            </span>
          </div>
          {summary.day_pnl != null && (
            <div className={`pf-card ${summary.day_pnl >= 0 ? "up" : "down"}`}>
              <span className="k">Today</span>
              <span className="v">
                {summary.day_pnl >= 0 ? "+" : "−"}${num(Math.abs(summary.day_pnl))}
              </span>
              <span className="sub">{pct(summary.day_pnl_pct)}</span>
            </div>
          )}
          <div className="pf-card">
            <span className="k">Winners</span>
            <span className="v">{summary.winners} / {summary.n_priced}</span>
            {summary.best && (
              <span className="sub up">best {summary.best.symbol} {pct(summary.best.pnl_pct)}</span>
            )}
          </div>
        </div>
      )}

      {summary?.concentration_pct > 33 && bySymbol.length > 1 && (
        <p className="concentration-warn">
          ⚠ <Explain term="Concentration" enabled={beginner}>{summary.largest_holding?.symbol}</Explain>{" "}
          is {pct(summary.concentration_pct)} of your portfolio. Your result is
          mostly that one bet.
        </p>
      )}

      {valued?.unknown_symbols?.length > 0 && (
        <p className="error-inline">
          ⚠ Not found, so not valued: {valued.unknown_symbols.join(", ")}. Check the
          ticker spelling.
        </p>
      )}

      {liveRows.length > 0 && (
        <div className="table-wrap">
          <table className="data-table positions-table">
            <thead>
              <tr>
                <th>Symbol</th><th>Shares</th>
                <th><Explain term="Cost basis" enabled={beginner}>Paid</Explain></th>
                <th>Cost</th><th>Now</th><th>Value</th>
                <th>Gain / loss</th><th>%</th><th>Today</th><th>Weight</th><th />
              </tr>
            </thead>
            <tbody>
              {liveRows.map((r) => (
                <tr key={r.id} className={r.pnl >= 0 ? "row-up" : "row-down"}>
                  <td>
                    <button className="link-sym" onClick={() => onSelect?.(r.symbol)}>
                      {r.symbol}
                    </button>
                    {r.opened && <div className="muted tiny">{r.opened}</div>}
                    {r.note && <div className="muted tiny" title={r.note}>
                      {r.note.length > 18 ? `${r.note.slice(0, 18)}…` : r.note}</div>}
                  </td>
                  <td>{num(r.shares, 4)}</td>
                  <td>${num(r.cost_basis)}</td>
                  <td>${num(r.cost)}</td>
                  <td>
                    {r.price ? `$${num(r.price)}` : "—"}
                    {r._live && <span className="live-dot tiny"> ●</span>}
                  </td>
                  <td>{r.market_value ? `$${num(r.market_value)}` : "—"}</td>
                  <td className={r.pnl >= 0 ? "up strong" : "down strong"}>
                    {r.pnl == null ? "—"
                      : `${r.pnl >= 0 ? "+" : "−"}$${num(Math.abs(r.pnl))}`}
                  </td>
                  <td className={r.pnl >= 0 ? "up" : "down"}>
                    {r.pnl_pct == null ? "—"
                      : `${r.pnl_pct >= 0 ? "+" : ""}${pct(r.pnl_pct)}`}
                  </td>
                  <td className={r.day_pnl >= 0 ? "up" : "down"}>
                    {r.day_pnl == null ? "—"
                      : `${r.day_pnl >= 0 ? "+" : "−"}$${num(Math.abs(r.day_pnl))}`}
                  </td>
                  <td className="muted">{r.weight_pct ? pct(r.weight_pct) : "—"}</td>
                  <td className="row-actions">
                    <button className="icon sell" title="Record a sale"
                            onClick={() => startSell(r)}>Sell</button>
                    <button className="icon" title="Edit" onClick={() => startEdit(r)}>✎</button>
                    <button className="icon danger" title="Remove"
                            onClick={() => remove(r)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bySymbol.length > 0 && bySymbol.length < rows.length && (
        <>
          <h3 className="sub-head">Combined by symbol</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Symbol</th><th>Lots</th><th>Shares</th><th>Avg cost</th>
                  <th>Value</th><th>Gain / loss</th><th>%</th></tr>
              </thead>
              <tbody>
                {bySymbol.map((r) => (
                  <tr key={r.symbol}>
                    <td className="strong">{r.symbol}</td>
                    <td>{r.lots}</td>
                    <td>{num(r.shares, 4)}</td>
                    <td>${num(r.avg_cost)}</td>
                    <td>${num(r.market_value)}</td>
                    <td className={r.pnl >= 0 ? "up strong" : "down strong"}>
                      {r.pnl >= 0 ? "+" : "−"}${num(Math.abs(r.pnl))}
                    </td>
                    <td className={r.pnl >= 0 ? "up" : "down"}>
                      {r.pnl_pct >= 0 ? "+" : ""}{pct(r.pnl_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {sell && (
        <form className="sell-form" onSubmit={confirmSell}>
          <h3 className="sub-head">Record a sale — {sell.symbol}</h3>
          <div className="pos-fields">
            <label>
              <span>Shares sold</span>
              <input type="number" step="any" min="0" autoFocus value={sell.shares}
                     onChange={(e) => setSell({ ...sell, shares: e.target.value })} />
            </label>
            <label>
              <span>Sold at</span>
              <input type="number" step="any" min="0" value={sell.price}
                     onChange={(e) => setSell({ ...sell, price: e.target.value })} />
            </label>
            <label>
              <span>Date sold</span>
              <input type="date" value={sell.date}
                     onChange={(e) => setSell({ ...sell, date: e.target.value })} />
            </label>
            <label>
              <span>Time <em>(optional)</em></span>
              <input type="time" value={sell.time} disabled={!sell.date}
                     onChange={(e) => setSell({ ...sell, time: e.target.value })} />
            </label>
            <label>
              <span>Which lots</span>
              <select value={sell.method}
                      onChange={(e) => setSell({ ...sell, method: e.target.value })}>
                <option value="fifo">Oldest first (FIFO)</option>
                <option value="lifo">Newest first (LIFO)</option>
              </select>
            </label>
            <div className="pos-submit">
              <button type="submit" disabled={sellBusy}>
                {sellBusy ? "Recording…" : "Record sale"}
              </button>
              <button type="button" className="ghost"
                      onClick={() => { setSell(null); setError(null); }}>Cancel</button>
            </div>
          </div>
          {sell.shares && sell.price && (
            <p className="pos-preview">
              Proceeds <strong>${num(Number(sell.shares) * Number(sell.price))}</strong>.
              {" "}Which lots you pick changes the gain and the tax treatment.
            </p>
          )}
        </form>
      )}

      <PhotoImport
        beginner={beginner}
        onImport={(rows) => {
          setPositions(mergePositions(positions, rows));
          flash(`Added ${rows.length} position${rows.length === 1 ? "" : "s"} from the photo.`);
        }}
      />

      <form className="position-form" onSubmit={submit}>
        <h3 className="sub-head">{editing ? "Edit position" : "Add a position"}</h3>
        <div className="pos-fields">
          <label>
            <span>Ticker</span>
            <input value={form.symbol} placeholder="NVDA" autoComplete="off"
                   onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} />
          </label>
          <label>
            <span>Shares</span>
            <input type="number" step="any" value={form.shares} placeholder="400"
                   onChange={(e) => setForm({ ...form, shares: e.target.value })} />
          </label>
          <label>
            <span>Price paid</span>
            <input type="number" step="any" min="0" value={form.cost_basis}
                   placeholder="178.50"
                   onChange={(e) => setForm({ ...form, cost_basis: e.target.value })} />
          </label>
          <label>
            <span>Date bought <em>(optional)</em></span>
            <input type="date" value={form.opened}
                   onChange={(e) => setForm({ ...form, opened: e.target.value })} />
          </label>
          <label>
            <span>Time <em>(optional)</em></span>
            <input type="time" value={form.openedTime} disabled={!form.opened}
                   title="For intraday trades — lets the holding period be exact"
                   onChange={(e) => setForm({ ...form, openedTime: e.target.value })} />
          </label>
          <label className="grow">
            <span>Note <em>(optional)</em></span>
            <input value={form.note} placeholder="why you bought it"
                   onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <div className="pos-submit">
            <button type="submit">{editing ? "Save" : "Add position"}</button>
            {editing && (
              <button type="button" className="ghost"
                      onClick={() => { setEditing(null); setForm(BLANK); }}>Cancel</button>
            )}
          </div>
        </div>
        {form.symbol && form.shares && form.cost_basis && (
          <p className="pos-preview">
            {num(Number(form.shares), 4)} shares of {form.symbol} at ${num(Number(form.cost_basis))} ={" "}
            <strong>${num(Number(form.shares) * Number(form.cost_basis))}</strong> invested.
          </p>
        )}
      </form>

      {error && <p className="error-inline">⚠ {error}</p>}
      {notice && <p className="notice-inline">✓ {notice}</p>}
      {busy && <p className="muted tiny">Pricing…</p>}

      <p className="fine-print">
        Saved in this browser only — never uploaded. Export to CSV or Excel to keep
        a copy, and import it back on another machine.
      </p>
    </section>
  );
}
