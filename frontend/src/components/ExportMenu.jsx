import { useEffect, useRef, useState } from "react";
import {
  downloadCsvUrl, exportEverything, exportPositions, exportRealized, saveBlob,
} from "../api.js";
import { positionsToCsv } from "../positions.js";
import { salesToCsv } from "../sales.js";

// One obvious way to get your data out.
//
// Export used to be four buttons scattered across four panels, which meant
// remembering which one produced which file. The primary action here is a
// single click that writes ONE workbook containing everything; the menu is for
// the rarer case of wanting just one piece in a specific format.
export default function ExportMenu({ symbols = [], positions = [], sales = [],
                                     period = "6mo", data = null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onAway = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onAway);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  function flashDone() {
    setDone(true);
    setTimeout(() => setDone(false), 2500);
  }

  async function run(fn, { localFallback } = {}) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      flashDone();
      setOpen(false);
    } catch (e) {
      // Holdings and sales are local data — a dead backend shouldn't stop you
      // saving your own list.
      if (localFallback) {
        localFallback();
        flashDone();
        setOpen(false);
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  const exportAll = () => run(() => exportEverything({
    symbols, positions, sales, period,
  }));

  const hasPositions = positions.length > 0;
  const hasSales = sales.length > 0;
  const nothing = !symbols.length && !hasPositions && !hasSales;

  return (
    <div className="export-wrap" ref={wrapRef}>
      <button className="export-main" onClick={exportAll}
              disabled={busy || nothing}
              title="Download one Excel file containing everything on this page">
        {busy ? "Preparing…" : done ? "✓ Saved" : "⬇ Export everything"}
      </button>
      <button className="export-caret" aria-label="More export options"
              aria-expanded={open} disabled={nothing}
              onClick={() => setOpen((v) => !v)}>▾</button>

      {open && (
        <div className="export-pop" role="menu">
          <p className="export-hint">
            One file with every sheet — or pick a single piece below.
          </p>

          <button role="menuitem" onClick={exportAll} disabled={busy}>
            <span className="ex-icon">📦</span>
            <span>
              <strong>Everything (Excel)</strong>
              <em>Watchlist, holdings, performance, dividends, closed trades</em>
            </span>
          </button>

          {hasPositions && (
            <>
              <button role="menuitem" disabled={busy}
                      onClick={() => run(
                        () => exportPositions(positions, "xlsx"),
                        {})}>
                <span className="ex-icon">💼</span>
                <span><strong>Holdings only (Excel)</strong>
                  <em>{positions.length} lot{positions.length === 1 ? "" : "s"}</em></span>
              </button>
              <button role="menuitem" disabled={busy}
                      onClick={() => run(
                        () => exportPositions(positions, "csv"),
                        {
                          localFallback: () => saveBlob(
                            new Blob([positionsToCsv(positions)], { type: "text/csv" }),
                            "holdings.csv"),
                        })}>
                <span className="ex-icon">📄</span>
                <span><strong>Holdings only (CSV)</strong>
                  <em>Opens anywhere; re-importable</em></span>
              </button>
            </>
          )}

          {hasSales && (
            <button role="menuitem" disabled={busy}
                    onClick={() => run(
                      () => exportRealized(sales, "csv"),
                      {
                        localFallback: () => saveBlob(
                          new Blob([salesToCsv(sales)], { type: "text/csv" }),
                          "realized_gains.csv"),
                      })}>
              <span className="ex-icon">🧾</span>
              <span><strong>Closed trades (CSV)</strong>
                <em>{sales.length} sale{sales.length === 1 ? "" : "s"}</em></span>
            </button>
          )}

          {symbols.length > 0 && (
            <a role="menuitem" className="export-link"
               href={downloadCsvUrl(symbols, period)} onClick={() => setOpen(false)}>
              <span className="ex-icon">📈</span>
              <span><strong>Watchlist data (CSV)</strong>
                <em>{symbols.length} symbol{symbols.length === 1 ? "" : "s"}</em></span>
            </a>
          )}

          <div className="export-sep" />

          {data && (
            <button role="menuitem" onClick={() => {
              const blob = new Blob([JSON.stringify(data, null, 2)],
                                    { type: "application/json" });
              saveBlob(blob, "analysis.json");
              setOpen(false);
            }}>
              <span className="ex-icon">{"{ }"}</span>
              <span><strong>Raw JSON</strong><em>For scripts and other tools</em></span>
            </button>
          )}

          <button role="menuitem" onClick={() => { setOpen(false); window.print(); }}>
            <span className="ex-icon">🖨</span>
            <span><strong>Print / save as PDF</strong>
              <em>Uses your browser's print dialog</em></span>
          </button>
        </div>
      )}

      {error && <span className="export-error" title={error}>⚠ {error}</span>}
    </div>
  );
}
