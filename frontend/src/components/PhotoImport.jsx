import { useRef, useState } from "react";
import { importPhoto } from "../api.js";
import { num } from "../format.js";

// Photograph a transaction history and get the trades out without retyping.
//
// The review table is the point of this component, not an afterthought. OCR
// misreads decimal points and will produce a confident-looking wrong number for
// a smudged cell, so nothing reaches the portfolio until the user has looked at
// every row and pressed the button. Rows are editable inline, because fixing
// one misread digit should not mean re-entering the whole trade.
export default function PhotoImport({ onImport, beginner = false }) {
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setRows(null);
    try {
      const res = await importPhoto(file);
      setMeta(res);
      setRows(res.rows.map((r, i) => ({ ...r, _id: i, _use: !r.needs_review })));
      if (!res.rows.length) {
        setError("No transactions found in that image. A clearer crop of just "
          + "the transaction list usually works better.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function edit(id, field, value) {
    setRows((rs) => rs.map((r) => (r._id === id ? { ...r, [field]: value } : r)));
  }

  function toggle(id) {
    setRows((rs) => rs.map((r) => (r._id === id ? { ...r, _use: !r._use } : r)));
  }

  function confirm() {
    const chosen = (rows || []).filter((r) => r._use);
    const usable = chosen
      .map((r) => ({
        symbol: String(r.symbol || "").trim().toUpperCase(),
        shares: Number(r.shares),
        cost_basis: Number(r.price),
        opened: r.opened || r.date || null,
        note: r.note ? `from photo: ${r.note}` : "imported from photo",
        _side: r.side,
      }))
      .filter((r) => r.symbol && Number.isFinite(r.shares) && r.shares > 0
        && Number.isFinite(r.cost_basis) && r.cost_basis > 0);

    if (!usable.length) {
      setError("Nothing selected has a symbol, a quantity and a price.");
      return;
    }
    onImport(usable);
    setRows(null);
    setMeta(null);
    setError(null);
  }

  const selected = (rows || []).filter((r) => r._use).length;

  return (
    <div className="photo-import">
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
      {/* capture="environment" opens the rear camera straight away on a phone. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment"
             hidden onChange={handleFile} />

      {!rows && (
        <div className="photo-actions">
          <button className="ghost" disabled={busy}
                  onClick={() => fileRef.current?.click()}>
            {busy ? "Reading…" : "📷 Import from a photo"}
          </button>
          <button className="ghost photo-camera" disabled={busy}
                  onClick={() => cameraRef.current?.click()}>
            Take a picture
          </button>
        </div>
      )}

      {beginner && !rows && !busy && (
        <p className="fine-print">
          Screenshot your broker's transaction list and the AI will read the
          trades out of it. You check every row before anything is saved.
        </p>
      )}

      {busy && <p className="muted tiny">Reading the image — this takes a few seconds.</p>}
      {error && <p className="error-inline">⚠ {error}</p>}

      {rows && rows.length > 0 && (
        <div className="photo-review">
          <div className="photo-review-head">
            <strong>Check these before saving</strong>
            <span className="muted tiny">
              read by {meta?.provider} · {meta?.n_need_review || 0} of{" "}
              {meta?.n_rows} need a look
            </span>
          </div>

          <p className="concentration-warn">
            ⚠ This was read from an image and <strong>has not been saved</strong>.
            Optical recognition gets decimal points wrong. Check every number
            against the original — especially the prices — before you confirm.
          </p>

          {meta?.warnings?.length > 0 && (
            <ul className="photo-warnings">
              {meta.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          <div className="table-wrap">
            <table className="data-table photo-table">
              <thead>
                <tr>
                  <th>Use</th><th>Symbol</th><th>Side</th><th>Qty</th>
                  <th>Price each</th><th>Date</th><th>Read</th><th>Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._id} className={r.needs_review ? "row-flag" : ""}>
                    <td>
                      <input type="checkbox" checked={r._use}
                             onChange={() => toggle(r._id)} />
                    </td>
                    <td>
                      <input className="photo-cell sym" value={r.symbol || ""}
                             placeholder="?"
                             onChange={(e) => edit(r._id, "symbol",
                               e.target.value.toUpperCase())} />
                    </td>
                    <td>
                      <span className={`term-tag ${r.side === "sell" ? "short" : "long"}`}>
                        {r.side}
                      </span>
                    </td>
                    <td>
                      <input className="photo-cell" type="number" step="any"
                             value={r.shares ?? ""} placeholder="?"
                             onChange={(e) => edit(r._id, "shares", e.target.value)} />
                    </td>
                    <td>
                      <input className="photo-cell" type="number" step="any"
                             value={r.price ?? ""} placeholder="?"
                             onChange={(e) => edit(r._id, "price", e.target.value)} />
                    </td>
                    <td>
                      <input className="photo-cell date" value={r.opened || ""}
                             placeholder="YYYY-MM-DD"
                             onChange={(e) => edit(r._id, "opened", e.target.value)} />
                    </td>
                    <td>
                      <span className={`conf ${r.confidence}`}>{r.confidence}</span>
                    </td>
                    <td className="photo-note">{r.note || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="photo-confirm">
            <button className="ghost" onClick={() => { setRows(null); setMeta(null); }}>
              Cancel
            </button>
            <button className="photo-save" onClick={confirm} disabled={!selected}>
              Add {selected} {selected === 1 ? "position" : "positions"}
            </button>
          </div>

          <p className="fine-print">
            Sells are added as positions too — record them, then use the Sell
            button on the row so the lot matching and realised gain are right.
            Totals shown here are {rows.filter((r) => r._use && r.shares && r.price)
              .reduce((a, r) => a + Number(r.shares) * Number(r.price), 0) > 0
              ? `$${num(rows.filter((r) => r._use && r.shares && r.price)
                  .reduce((a, r) => a + Number(r.shares) * Number(r.price), 0))} of trades`
              : "incomplete"}.
          </p>
        </div>
      )}
    </div>
  );
}
