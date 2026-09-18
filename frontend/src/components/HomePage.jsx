import { useState, useEffect } from "react";
import { quotes as fetchQuotes } from "../api.js";
import { loadPositions } from "../positions.js";
import { ago, clearRecents, loadRecents, recordSearch, removeRecent } from "../recents.js";
import ModeSwitch from "./ModeSwitch.jsx";

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

function Card({ q, label, onClick, badge, sub }) {
  const up = (q?.change_pct ?? 0) >= 0;
  return (
    <button className="standing-card" onClick={onClick}>
      <div className="sc-top">
        <span className="sc-sym">
          {label || q.symbol}
          {badge && <span className="sc-badge">{badge}</span>}
        </span>
        <span className="sc-name">{q.name}</span>
      </div>
      <div className="sc-price">{fmt(q.price)}</div>
      <div className={`sc-chg ${up ? "pos" : "neg"}`}>
        {up ? "▲" : "▼"} {fmt(q.change)} ({fmt(q.change_pct)}%)
      </div>
      {sub && <div className="sc-sub">{sub}</div>}
    </button>
  );
}

export default function HomePage({ onSearch, theme, toggleTheme, mode, setMode,
                                   onStartTour }) {
  const [query, setQuery] = useState("");
  const [quotesBySymbol, setQuotesBySymbol] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(null);
  const [checking, setChecking] = useState(false);
  const [recents, setRecents] = useState(loadRecents);
  const [positions] = useState(loadPositions);

  const watchSymbols = (localStorage.getItem(LS_SYMBOLS) || "AAPL, MSFT, NVDA")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  // Symbols the user actually owns, with their share counts, from localStorage.
  const holdingBySymbol = positions.reduce((acc, p) => {
    acc[p.symbol] = acc[p.symbol] || { shares: 0, cost: 0 };
    acc[p.symbol].shares += p.shares;
    acc[p.symbol].cost += p.shares * p.cost_basis;
    return acc;
  }, {});
  const holdingSymbols = Object.keys(holdingBySymbol);

  const recentSymbols = recents
    .map((r) => r.symbol)
    // Don't repeat something already shown as a holding or in the watchlist.
    .filter((s) => !holdingSymbols.includes(s) && !watchSymbols.includes(s));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        // One request for everything on the page — indices, watchlist, holdings
        // and recents overlap a lot, so de-duplicating first saves real calls.
        const all = [...new Set([
          ...INDICES.map((i) => i[0]), ...watchSymbols,
          ...holdingSymbols, ...recentSymbols,
        ])];
        const res = await fetchQuotes(all);
        if (cancelled) return;
        const map = {};
        for (const q of res.quotes || []) if (!q.not_found) map[q.symbol] = q;
        setQuotesBySymbol(map);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve the ticker BEFORE navigating, so a typo says "not found" here
  // instead of opening an analysis page that can't load anything.
  async function submit() {
    const raw = query.trim().toUpperCase();
    if (!raw) return;
    const syms = raw.split(",").map((s) => s.trim()).filter(Boolean);
    setNotFound(null);
    setChecking(true);
    try {
      const res = await fetchQuotes(syms);
      const bad = (res.quotes || []).filter((q) => q.not_found).map((q) => q.symbol);
      if (bad.length === syms.length) { setNotFound(bad); return; }
      if (bad.length) setNotFound(bad);
      const good = syms.filter((s) => !bad.includes(s));
      setRecents(recordSearch(good));
      onSearch(good.join(", "));
    } catch (e) {
      if (e.notFound) setNotFound([e.symbol || raw]);
      else { setRecents(recordSearch(syms)); onSearch(raw); }
    } finally {
      setChecking(false);
    }
  }

  function open(symbol) {
    setRecents(recordSearch(symbol));
    onSearch(symbol);
  }

  // The search box doubles as a live filter over everything below.
  const match = (q) =>
    !query ||
    q.symbol.toUpperCase().includes(query.toUpperCase()) ||
    (q.name || "").toLowerCase().includes(query.toLowerCase());

  const idxLabel = Object.fromEntries(INDICES);
  const pick = (syms) => syms.map((s) => quotesBySymbol[s]).filter(Boolean).filter(match);

  const filteredIdx = pick(INDICES.map((i) => i[0]));
  const filteredHoldings = pick(holdingSymbols);
  const filteredWatch = pick(watchSymbols.filter((s) => !holdingSymbols.includes(s)));
  const filteredRecents = pick(recentSymbols);

  function Section({ title, items, children, empty, action }) {
    return (
      <section className="standings">
        <div className="standings-head">
          <h2>{title}</h2>
          {action}
        </div>
        {items.length ? (
          <div className="standing-grid">{children}</div>
        ) : (
          <p className="muted">{empty}</p>
        )}
      </section>
    );
  }

  return (
    <div className="home">
      <div className="hero">
        <div className="logo-mark" style={{ position: "relative" }}>
          📈
          <span className="home-corner">
            <button className="help-btn" onClick={onStartTour}
                    title="Show me around" aria-label="Show me around">?</button>
            <button className="theme-btn" onClick={toggleTheme}
                    title="Toggle theme">
              {theme === "dark" ? "☀️" : "🌙"}
            </button>
          </span>
        </div>
        <h1>Stock Analysis Engine</h1>
        <p className="tagline">
          A free, lean charting tool — candlesticks, indicators, fundamentals,
          projections, holdings tracking, and an AI analyst.
        </p>

        <ModeSwitch mode={mode} onChange={setMode} />
        <p className="mode-hint">
          {mode === "beginner"
            ? "Beginner mode: every term explained, jargon stripped out."
            : mode === "daytrader"
              ? "Day-trader mode: intraday levels, position sizing and live P/L."
              : "Standard mode: the full research dashboard."}
        </p>

        <div className="search">
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setNotFound(null); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Search a ticker (e.g. AAPL or SPY) or filter below…"
          />
          <button onClick={submit} disabled={checking}>
            {checking ? "Checking…" : "Analyze →"}
          </button>
        </div>
        {notFound ? (
          <p className="not-found-inline">
            🔎 <strong>Stock/ETF not found:</strong> <code>{notFound.join(", ")}</code>
            {" "}— check the spelling. Use the exchange ticker (AAPL, not Apple).
          </p>
        ) : (
          <p className="search-hint">
            Press Enter or click Analyze to open the full chart &amp; analysis page.
          </p>
        )}
      </div>

      {error && <div className="error">⚠ {error}</div>}

      {loading && (
        <section className="standings">
          <h2>Markets</h2>
          <div className="skeleton-standings">
            {[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton skeleton-card" />)}
          </div>
        </section>
      )}

      {!loading && (
        <>
          <Section title="Markets" items={filteredIdx}
                   empty={`No markets match “${query}”.`}>
            {filteredIdx.map((q) => (
              <Card key={q.symbol} q={q} label={idxLabel[q.symbol]}
                    onClick={() => open(q.symbol)} />
            ))}
          </Section>

          {holdingSymbols.length > 0 && (
            <Section title="💼 Your investments" items={filteredHoldings}
                     empty={`None of your holdings match “${query}”.`}>
              {filteredHoldings.map((q) => {
                const h = holdingBySymbol[q.symbol];
                const value = h.shares * q.price;
                const pnl = value - h.cost;
                return (
                  <Card key={q.symbol} q={q} onClick={() => open(q.symbol)}
                        badge={`${fmt(h.shares, 4)} sh`}
                        sub={
                          <span className={pnl >= 0 ? "pos" : "neg"}>
                            {pnl >= 0 ? "+" : "−"}${fmt(Math.abs(pnl))} overall
                          </span>
                        } />
                );
              })}
            </Section>
          )}

          <Section title="Your watchlist" items={filteredWatch}
                   empty={query ? `No watchlist symbols match “${query}”.`
                                : "Search a ticker to start a watchlist."}>
            {filteredWatch.map((q) => (
              <Card key={q.symbol} q={q} onClick={() => open(q.symbol)} />
            ))}
          </Section>

          {recentSymbols.length > 0 && (
            <Section
              title="🕘 Recent searches"
              items={filteredRecents}
              empty={`No recent searches match “${query}”.`}
              action={
                <button className="ghost tiny-btn"
                        onClick={() => setRecents(clearRecents())}>
                  Clear
                </button>
              }
            >
              {filteredRecents.map((q) => {
                const rec = recents.find((r) => r.symbol === q.symbol);
                return (
                  <div key={q.symbol} className="recent-wrap">
                    <Card q={q} onClick={() => open(q.symbol)}
                          sub={<span className="muted">{ago(rec?.at)}</span>} />
                    <button className="recent-x" title="Remove from recent searches"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRecents(removeRecent(q.symbol));
                            }}>✕</button>
                  </div>
                );
              })}
            </Section>
          )}

          <p className="storage-note">
            Your watchlist, holdings and recent searches are stored in this
            browser's local storage — no cookies, no account, nothing uploaded.
            Recent searches keep the last 12 tickers only.
          </p>
        </>
      )}
    </div>
  );
}
