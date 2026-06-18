import { useState, useEffect } from "react";
import { quotes as fetchQuotes } from "../api.js";

// Major indices shown under "Markets".
const INDICES = [
  ["^GSPC", "S&P 500"], ["^IXIC", "Nasdaq"], ["^DJI", "Dow Jones"],
  ["^RUT", "Russell 2000"], ["^VIX", "Volatility (VIX)"],
];
const LS_SYMBOLS = "sae:symbols";

function fmt(n, d = 2) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

function Card({ q, label, onClick }) {
  const up = (q?.change_pct ?? 0) >= 0;
  return (
    <button className="standing-card" onClick={onClick}>
      <div className="sc-top">
        <span className="sc-sym">{label || q.symbol}</span>
        <span className="sc-name">{q.name}</span>
      </div>
      <div className="sc-price">{fmt(q.price)}</div>
      <div className={`sc-chg ${up ? "pos" : "neg"}`}>
        {up ? "▲" : "▼"} {fmt(q.change)} ({fmt(q.change_pct)}%)
      </div>
    </button>
  );
}

export default function HomePage({ onSearch, theme, toggleTheme }) {
  const [query, setQuery] = useState("");
  const [indices, setIndices] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const savedSymbols = (localStorage.getItem(LS_SYMBOLS) || "AAPL, MSFT, NVDA")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const idxSyms = INDICES.map((i) => i[0]);
        const [idx, wl] = await Promise.all([
          fetchQuotes(idxSyms),
          savedSymbols.length ? fetchQuotes(savedSymbols) : Promise.resolve({ quotes: [] }),
        ]);
        if (!cancelled) {
          setIndices(idx.quotes || []);
          setWatchlist(wl.quotes || []);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    const q = query.trim();
    if (q) onSearch(q.toUpperCase());
  }

  // The search box doubles as a live filter over the standings below.
  const match = (q) =>
    !query ||
    q.symbol.toUpperCase().includes(query.toUpperCase()) ||
    (q.name || "").toLowerCase().includes(query.toLowerCase());

  const idxLabel = Object.fromEntries(INDICES);
  const filteredIdx = indices.filter(match);
  const filteredWl = watchlist.filter(match);

  return (
    <div className="home">
      <div className="hero">
        <div className="logo-mark" style={{ position: "relative" }}>
          📈
          <button className="theme-btn" onClick={toggleTheme}
                  style={{ position: "absolute", right: 0, top: 0, fontSize: "0.9rem" }}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
        <h1>Stock Analysis Engine</h1>
        <p className="tagline">
          A free, lean charting tool — candlesticks, indicators, fundamentals, and an AI analyst.
        </p>
        <div className="search">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Search a ticker (e.g. AAPL) or filter below…"
          />
          <button onClick={submit}>Analyze →</button>
        </div>
        <p className="search-hint">Press Enter or click Analyze to open the full chart & analysis page.</p>
      </div>

      {error && <div className="error">⚠ {error}</div>}
      {loading && (
        <>
          <section className="standings">
            <h2>Markets</h2>
            <div className="skeleton-standings">
              {[1,2,3,4,5].map((i) => <div key={i} className="skeleton skeleton-card" />)}
            </div>
          </section>
          <section className="standings">
            <h2>Your watchlist</h2>
            <div className="skeleton-standings">
              {[1,2,3].map((i) => <div key={i} className="skeleton skeleton-card" />)}
            </div>
          </section>
        </>
      )}

      {!loading && (
        <>
          <section className="standings">
            <h2>Markets</h2>
            <div className="standing-grid">
              {filteredIdx.length ? filteredIdx.map((q) => (
                <Card key={q.symbol} q={q} label={idxLabel[q.symbol]}
                      onClick={() => onSearch(q.symbol)} />
              )) : <p className="muted">No markets match “{query}”.</p>}
            </div>
          </section>

          <section className="standings">
            <h2>Your watchlist</h2>
            <div className="standing-grid">
              {filteredWl.length ? filteredWl.map((q) => (
                <Card key={q.symbol} q={q} onClick={() => onSearch(q.symbol)} />
              )) : <p className="muted">No watchlist symbols match “{query}”.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
