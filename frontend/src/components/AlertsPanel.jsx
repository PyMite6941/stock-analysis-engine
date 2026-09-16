import { useState } from "react";
import {
  TYPES, addAlert, clearFired, label as alertLabel, notificationPermission,
  removeAlert, requestNotifications, toggleAlert,
} from "../alerts.js";

const BLANK = { type: "price_above", symbol: "", threshold: "", repeat: false };

// Price and position alerts, checked against data the app is already polling.
//
// Honest about its one real limitation: no server means no alerts while the tab
// is closed. Saying that plainly is better than someone missing a stop because
// they assumed otherwise.
export default function AlertsPanel({ alerts, setAlerts, fired, setFired,
                                      symbols = [], focused }) {
  const [form, setForm] = useState(() => ({ ...BLANK, symbol: focused || "" }));
  const [error, setError] = useState(null);
  const [perm, setPerm] = useState(notificationPermission);

  const meta = TYPES[form.type];

  function submit(e) {
    e.preventDefault();
    const threshold = Number(form.threshold);
    if (!Number.isFinite(threshold) || form.threshold === "") {
      return setError("Enter a number to alert on.");
    }
    if (meta.needsSymbol && !form.symbol.trim()) {
      return setError("Which ticker?");
    }
    setError(null);
    setAlerts(addAlert(alerts, { ...form, threshold }));
    setForm({ ...BLANK, type: form.type, symbol: form.symbol });
  }

  async function askPermission() {
    setPerm(await requestNotifications());
  }

  return (
    <section className="panel alerts-panel">
      <div className="panel-head">
        <h2>🔔 Alerts {alerts.length > 0 && <span className="count-pill">{alerts.length}</span>}</h2>
        {perm !== "granted" && perm !== "unsupported" && (
          <button className="ghost" onClick={askPermission}>
            Enable desktop notifications
          </button>
        )}
      </div>

      {fired.length > 0 && (
        <div className="fired-list">
          <div className="fired-head">
            <strong>Recently triggered</strong>
            <button className="tiny-btn" onClick={() => setFired(clearFired())}>
              Clear
            </button>
          </div>
          {fired.slice(0, 5).map((f, i) => (
            <div key={`${f.id}-${i}`} className="fired-row">
              <span>🔔 {f.message}</span>
              <span className="muted tiny">
                {new Date(f.at).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}

      {alerts.length > 0 && (
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.id} className={a.enabled ? "" : "off"}>
              <label className="alert-toggle">
                <input type="checkbox" checked={a.enabled}
                       onChange={() => setAlerts(toggleAlert(alerts, a.id))} />
                <span>{alertLabel(a)}</span>
              </label>
              <span className="alert-tags">
                {a.repeat && <span className="tag">repeats</span>}
                {a.lastFired && (
                  <span className="tag fired" title={new Date(a.lastFired).toLocaleString()}>
                    fired
                  </span>
                )}
              </span>
              <button className="icon danger" title="Delete"
                      onClick={() => setAlerts(removeAlert(alerts, a.id))}>✕</button>
            </li>
          ))}
        </ul>
      )}

      <form className="alert-form" onSubmit={submit}>
        <select value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {Object.entries(TYPES).map(([k, t]) => (
            <option key={k} value={k}>{t.label}</option>
          ))}
        </select>

        {meta.needsSymbol && (
          <input className="alert-sym" list="alert-symbols" placeholder="AAPL"
                 value={form.symbol}
                 onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} />
        )}
        <datalist id="alert-symbols">
          {symbols.map((s) => <option key={s} value={s} />)}
        </datalist>

        <div className="alert-threshold">
          {meta.unit === "$" && <span className="prefix">$</span>}
          <input type="number" step="any" placeholder="0"
                 value={form.threshold}
                 onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
          {meta.unit === "%" && <span className="suffix">%</span>}
        </div>

        <label className="alert-repeat" title="Re-arm after firing (max once an hour)">
          <input type="checkbox" checked={form.repeat}
                 onChange={(e) => setForm({ ...form, repeat: e.target.checked })} />
          <span>repeat</span>
        </label>

        <button type="submit">Add alert</button>
      </form>

      {error && <p className="error-inline">⚠ {error}</p>}

      <p className="fine-print">
        Alerts are checked against the live quotes this page already polls, so
        they only fire <strong>while a tab is open</strong>. Nothing is sent to a
        server and no account is needed — which is also why they can't reach you
        when the browser is closed. For anything you'd act on, use your broker's
        alerts too.
        {perm === "denied" && " Desktop notifications are blocked, so alerts will "
          + "only appear here in the page."}
      </p>
    </section>
  );
}
