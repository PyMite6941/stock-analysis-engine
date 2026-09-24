import { useEffect, useRef, useState } from "react";
import { exportPositions, importPositions, portfolio as fetchPortfolio,
         quotes as fetchQuotes, saveBlob, sellPosition } from "../api.js";
import { money, num, pct } from "../format.js";
import {
  addPosition, csvToPositions, loadPositions, mergePositions, positionsToCsv,
  removePosition, replacePositions, updatePosition,
} from "../positions.js";
import Explain from "./Explain.jsx";
import PhotoImport from "./PhotoImport.jsx";
import { backendAvailable } from "../runtime.js";
import SymbolSearch from "./SymbolSearch.jsx";

const BLANK = { symbol: "", shares: "", cost_basis: "", opened: "",
                openedTime: "", note: "", exit_plan: "" };

// Two ways people remember a purchase. Brokers show both, and which one you
// recall depends on how you bought: "400 shares at 178.50" for a limit order,
// "I put $5,000 in" for anything bought by dollar amount — which is how
// fractional-share investing works at most brokers now. Forcing per-share
// entry means doing division by hand before you can type anything.
const PER_SHARE = "share";
const TOTAL = "total";
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
                                         setPositions, onSold,
                                         focusedSymbol = null }) {
  const [valued, setValued] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sell, setSell] = useState(null);          // SELL_BLANK when open
  const [sellBusy, setSellBusy] = useState(false);
  const fileRef = useRef(null);
  // Optional fields start hidden. Seven inputs at once reads as a tax return;
  // the three that are actually required read as a sentence.
  const [showMore, setShowMore] = useState(false);
  const [costMode, setCostMode] = useState(PER_SHARE);
  // Live quote for whatever ticker is half-typed in the form, so the price can
  // be offered instead of looked up in another tab.
  const [formQuote, setFormQuote] = useState(null);
  const formRef = useRef(null);
  const sharesRef = useRef(null);
  // Incremented whenever the form fills the ticker itself, so the autocomplete
  // stays shut for a value the user did not type.
  const [prefillToken, setPrefillToken] = useState(0);

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

  // Price the ticker being typed. Debounced, and it tolerates failure in
  // silence: this only ever OFFERS a number, so a miss costs nothing and an
  // error message about it would be noise.
  useEffect(() => {
    const sym = form.symbol.trim().toUpperCase();
    if (sym.length < 1 || sym.includes(",")) { setFormQuote(null); return undefined; }
    if (formQuote?.symbol === sym) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchQuotes([sym])
        .then((res) => {
          // `quotes()` resolves to { quotes: [...] }, not a bare array.
          const q = (res?.quotes || []).find((x) => x.symbol === sym && !x.not_found);
          if (!cancelled) setFormQuote(q?.price ? q : null);
        })
        .catch(() => { if (!cancelled) setFormQuote(null); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [form.symbol]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** Open the add form, optionally pre-filled with a ticker, and focus it. */
  function startAdd(symbol) {
    setEditing(null);
    setForm({ ...BLANK, symbol: symbol || "" });
    if (symbol) setPrefillToken((n) => n + 1);
    setCostMode(PER_SHARE);
    setShowMore(false);
    setError(null);
    // Let the form render before scrolling to it, otherwise we measure the
    // position it had before expanding.
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (symbol) sharesRef.current?.focus();
    });
  }

  function flash(msg) {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  }

  // Whatever was typed in the cost field, resolved to a per-share basis — the
  // one thing the rest of the app stores. Returns null when it can't be worked
  // out, so the caller decides what to say about it.
  function perShareCost() {
    const typed = Number(form.cost_basis);
    const shares = Number(form.shares);
    if (!Number.isFinite(typed) || typed <= 0) return null;
    if (costMode === PER_SHARE) return typed;
    if (!Number.isFinite(shares) || shares === 0) return null;
    return typed / Math.abs(shares);
  }

  function submit(e) {
    e.preventDefault();
    const cost = perShareCost();
    const entry = {
      symbol: form.symbol.trim().toUpperCase(),
      shares: Number(form.shares),
      cost_basis: cost,
      opened: stamp(form.opened, form.openedTime),
      note: form.note?.trim() || null,
      exit_plan: form.exit_plan?.trim() || null,
    };
    if (!entry.symbol) return setError("Which stock? Type a ticker or a company name.");
    if (!Number.isFinite(entry.shares) || entry.shares === 0)
      return setError("How many shares did you buy?");
    if (cost === null)
      return setError(costMode === TOTAL
        ? "Enter the total you spent — and the share count, so it can be divided."
        : "Enter the price you paid per share.");

    setError(null);
    setPositions(editing ? updatePosition(positions, editing, entry)
                         : addPosition(positions, entry));
    flash(editing ? `Updated ${entry.symbol}.`
                  : `Added ${num(entry.shares, 4)} ${entry.symbol} at ${money(cost)}.`);
    setForm(BLANK);
    setCostMode(PER_SHARE);
    setShowMore(false);
    setEditing(null);
  }

  function startEdit(row) {
    setEditing(row.id);
    const when = unstamp(row.opened);
    setForm({
      symbol: row.symbol, shares: String(row.shares),
      cost_basis: String(row.cost_basis), opened: when.date,
      openedTime: when.time, note: row.note || "",
      exit_plan: row.exit_plan || "",
    });
    setPrefillToken((n) => n + 1);
    setCostMode(PER_SHARE);       // what we stored is per-share, so show that
    // Reveal the optional fields when this row HAS any, otherwise editing looks
    // like it silently dropped the note you wrote.
    setShowMore(Boolean(row.opened || row.note || row.exit_plan));
    setError(null);
    requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
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
      flash(`Sold ${num(shares, 4)} ${sell.symbol} — realised ${money(total, { sign: true })}.`);
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
        <div className="pos-actions">
          {/* Prefilled with whatever stock is on screen, which is almost always
              the one being added — retyping a ticker you are already looking at
              is the most avoidable step in the whole flow. */}
          <button className="primary-sm" onClick={() => startAdd(focusedSymbol)}>
            ＋ Add{focusedSymbol ? ` ${focusedSymbol}` : " position"}
          </button>
          {positions.length > 0 && (
            <>
              <button className="ghost" onClick={() => doExport("csv")}>⬇ CSV</button>
              <button className="ghost" onClick={() => doExport("xlsx")}>⬇ Excel</button>
              <button className="ghost" onClick={() => fileRef.current?.click()}>⬆ Import</button>
            </>
          )}
        </div>
      </div>
      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xlsm" hidden onChange={onFile} />

      {positions.length === 0 && (
        <div className="pos-empty">
          <p>
            Record what you bought and this page tracks it: what it cost, what
            it's worth now, and whether you're up or down. Saved in this browser
            only — never uploaded.
          </p>
          {/* Three ways in, ranked by effort. Someone with a brokerage export
              should never be typing rows in by hand, and until now the import
              button only appeared AFTER the list was non-empty — exactly
              backwards. */}
          <div className="pos-empty-ways">
            <button className="primary-sm" onClick={() => startAdd(focusedSymbol)}>
              ＋ Type one in
            </button>
            <button className="ghost" onClick={() => fileRef.current?.click()}>
              ⬆ Import a CSV or Excel file
            </button>
            <span className="muted tiny">
              …or photograph your broker's transaction list, below.
            </span>
          </div>
        </div>
      )}

      {summary && liveCost > 0 && (
        <div className="portfolio-summary">
          <div className="pf-card">
            <span className="k">Invested</span>
            <span className="v">{money(liveCost)}</span>
          </div>
          <div className="pf-card">
            <span className="k">Worth now</span>
            <span className="v">{money(liveTotal)}</span>
          </div>
          <div className={`pf-card big ${livePnl >= 0 ? "up" : "down"}`}>
            <span className="k"><Explain term="Unrealised P/L" enabled={beginner}>
              {livePnl >= 0 ? "Total gain" : "Total loss"}</Explain></span>
            <span className="v">
              {money(livePnl, { sign: true })}
            </span>
            <span className="sub">
              {livePnl >= 0 ? "+" : ""}{pct(liveCost ? (livePnl / liveCost) * 100 : 0)}
            </span>
          </div>
          {summary.day_pnl != null && (
            <div className={`pf-card ${summary.day_pnl >= 0 ? "up" : "down"}`}>
              <span className="k">Today</span>
              <span className="v">
                {money(summary.day_pnl, { sign: true })}
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
                    {r.exit_plan && (
                      <div className="exit-plan tiny" title={`Sell when: ${r.exit_plan}`}>
                        ⤶ {r.exit_plan.length > 18
                          ? `${r.exit_plan.slice(0, 18)}…` : r.exit_plan}
                      </div>
                    )}
                  </td>
                  <td>{num(r.shares, 4)}</td>
                  <td>{money(r.cost_basis)}</td>
                  <td>{money(r.cost)}</td>
                  <td>
                    {r.price ? money(r.price) : "—"}
                    {r._live && <span className="live-dot tiny"> ●</span>}
                  </td>
                  <td>{r.market_value ? money(r.market_value) : "—"}</td>
                  <td className={r.pnl >= 0 ? "up strong" : "down strong"}>
                    {r.pnl == null ? "—"
                      : money(r.pnl, { sign: true })}
                  </td>
                  <td className={r.pnl >= 0 ? "up" : "down"}>
                    {r.pnl_pct == null ? "—"
                      : `${r.pnl_pct >= 0 ? "+" : ""}${pct(r.pnl_pct)}`}
                  </td>
                  <td className={r.day_pnl >= 0 ? "up" : "down"}>
                    {r.day_pnl == null ? "—"
                      : money(r.day_pnl, { sign: true })}
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
                    <td>{money(r.avg_cost)}</td>
                    <td>{money(r.market_value)}</td>
                    <td className={r.pnl >= 0 ? "up strong" : "down strong"}>
                      {money(r.pnl, { sign: true })}
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
              Proceeds <strong>{money(Number(sell.shares) * Number(sell.price))}</strong>.
              {" "}Which lots you pick changes the gain and the tax treatment.
            </p>
          )}
        </form>
      )}

      {/* Reading a photo needs the vision model on the server. */}
      {backendAvailable() && (
        <PhotoImport
          beginner={beginner}
          onImport={(rows) => {
            setPositions(mergePositions(positions, rows));
            flash(`Added ${rows.length} position${rows.length === 1 ? "" : "s"} from the photo.`);
          }}
        />
      )}

      <form className="position-form" onSubmit={submit} ref={formRef}>
        <h3 className="sub-head">{editing ? "Edit position" : "Add a position"}</h3>

        {/* The three fields you cannot avoid. Everything else is behind the
            toggle below, because a form that asks seven questions to record
            one purchase is why people give up and use a spreadsheet. */}
        <div className="pos-fields">
          <label className="pos-ticker">
            <span>Stock</span>
            <SymbolSearch
              value={form.symbol}
              onChange={(v) => setForm({ ...form, symbol: v.toUpperCase() })}
              onSubmit={(v) => {
                setForm({ ...form, symbol: String(v).toUpperCase() });
                sharesRef.current?.focus();
              }}
              placeholder="NVDA, or type Nvidia"
              skipToken={prefillToken}
            />
          </label>
          <label>
            <span>Shares</span>
            <input type="number" step="any" value={form.shares} placeholder="400"
                   ref={sharesRef}
                   onChange={(e) => setForm({ ...form, shares: e.target.value })} />
          </label>
          <label className="pos-cost">
            <span className="cost-label">
              {/* A segmented control, not a dropdown: both options have to be
                  visible for anyone to realise the second one exists. */}
              <button type="button"
                      className={`seg ${costMode === PER_SHARE ? "on" : ""}`}
                      onClick={() => setCostMode(PER_SHARE)}>Per share</button>
              <button type="button"
                      className={`seg ${costMode === TOTAL ? "on" : ""}`}
                      onClick={() => setCostMode(TOTAL)}>Total spent</button>
            </span>
            <input type="number" step="any" min="0" value={form.cost_basis}
                   placeholder={costMode === PER_SHARE ? "178.50" : "5,000"}
                   onChange={(e) => setForm({ ...form, cost_basis: e.target.value })} />
          </label>
          <div className="pos-submit">
            <button type="submit">{editing ? "Save" : "Add position"}</button>
            {(editing || form.symbol) && (
              <button type="button" className="ghost"
                      onClick={() => { setEditing(null); setForm(BLANK);
                                       setShowMore(false); setCostMode(PER_SHARE); }}>
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Offer the live price rather than making someone open another tab to
            find it. It fills the field; it never fills itself, because the
            price now and the price you paid are only the same on the day you
            bought. */}
        {formQuote && costMode === PER_SHARE && (
          <p className="price-offer">
            {formQuote.symbol} is trading at <strong>{money(formQuote.price)}</strong>
            {" "}
            <button type="button" className="link-btn"
                    onClick={() => setForm({ ...form,
                                             cost_basis: String(formQuote.price) })}>
              use this price
            </button>
            <span className="muted"> — only right if you bought today.</span>
          </p>
        )}

        <button type="button" className="more-toggle"
                aria-expanded={showMore}
                onClick={() => setShowMore((v) => !v)}>
          {showMore ? "▾" : "▸"} Date, notes and exit plan
          <span className="muted"> — optional</span>
        </button>

        {showMore && (
          <div className="pos-fields pos-extra">
            <label>
              <span>Date bought</span>
              <input type="date" value={form.opened}
                     onChange={(e) => setForm({ ...form, opened: e.target.value })} />
            </label>
            <label>
              <span>Time</span>
              <input type="time" value={form.openedTime} disabled={!form.opened}
                     title="For intraday trades — lets the holding period be exact"
                     onChange={(e) => setForm({ ...form, openedTime: e.target.value })} />
            </label>
            <label className="grow">
              <span>Why you bought it</span>
              <input value={form.note} placeholder="post-earnings add, cheap vs peers…"
                     onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
            <label className="grow">
              <span>What would make you sell</span>
              <input value={form.exit_plan}
                     placeholder="margins fall below 60%, or +40%"
                     title="Written now, while you have no position to defend"
                     onChange={(e) => setForm({ ...form, exit_plan: e.target.value })} />
            </label>
          </div>
        )}

        {/* Always show the arithmetic, in whichever direction it was entered:
            the number you did NOT type is the one worth checking. */}
        {form.symbol && form.shares && form.cost_basis && perShareCost() && (
          <p className="pos-preview">
            {num(Number(form.shares), 4)} shares of {form.symbol}
            {costMode === PER_SHARE ? (
              <> at {money(perShareCost())} = <strong>
                {money(Number(form.shares) * perShareCost())}</strong> invested.</>
            ) : (
              <> for {money(Number(form.cost_basis))} = <strong>
                {money(perShareCost())}</strong> per share.</>
            )}
            {formQuote?.price && (
              <span className={perShareCost() <= formQuote.price ? "up" : "down"}>
                {" "}Worth {money(Number(form.shares) * formQuote.price)} today.
              </span>
            )}
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
