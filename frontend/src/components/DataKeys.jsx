import { useState } from "react";
import { forgetKeys, loadKeys, saveKeys } from "../direct.js";

// Where a visitor pastes their own free API keys when the site runs without a
// backend. Read direct.js for why keys are needed and why they must be yours.
export default function DataKeys({ onSaved }) {
  const [keys, setKeys] = useState(loadKeys);
  const [note, setNote] = useState(null);

  function save(e) {
    e.preventDefault();
    const saved = saveKeys(keys);
    const rejected = ["finnhub", "twelvedata"].filter((k) => keys[k] && !saved[k]);
    setKeys(saved);
    setNote(rejected.length
      ? `That doesn't look like a key (${rejected.join(", ")}): letters and numbers only.`
      : "Saved. Loading prices…");
    if (!rejected.length) onSaved?.();
  }

  function forget() {
    forgetKeys();
    setKeys({ finnhub: "", twelvedata: "" });
    setNote("Keys removed from this browser.");
  }

  return (
    <form className="data-keys" onSubmit={save}>
      <p>
        This copy of the site has no server, so your browser fetches prices
        itself. That needs two <strong>free</strong> keys (about a minute each to get, no card):
      </p>
      <ol>
        <li><a href="https://finnhub.io/register" target="_blank" rel="noopener noreferrer">Finnhub</a> — live prices, names, search, streaming</li>
        <li><a href="https://twelvedata.com/register" target="_blank" rel="noopener noreferrer">Twelve Data</a> — chart history</li>
      </ol>
      <div className="pos-fields">
        <label className="grow">Finnhub key
          <input type="password" autoComplete="off" spellCheck="false" value={keys.finnhub}
                 onChange={(e) => setKeys({ ...keys, finnhub: e.target.value })} />
        </label>
        <label className="grow">Twelve Data key
          <input type="password" autoComplete="off" spellCheck="false" value={keys.twelvedata}
                 onChange={(e) => setKeys({ ...keys, twelvedata: e.target.value })} />
        </label>
        <div className="pos-submit">
          <button type="submit">Save</button>
          <button type="button" className="ghost" onClick={forget}>Forget</button>
        </div>
      </div>
      {note && <p className="pos-preview">{note}</p>}
      <p className="muted tiny">
        🔒 Keys stay in this browser (localStorage) and are only ever sent to
        the provider they belong to. No account, no sign-in. On a shared
        computer, click Forget when you're done.
      </p>
    </form>
  );
}
