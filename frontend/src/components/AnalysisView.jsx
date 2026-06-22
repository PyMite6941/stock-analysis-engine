import { useState, useEffect, useRef } from "react";
import { analyze, quotes, downloadCsvUrl } from "../api.js";
import { useRealtime } from "../useRealtime.js";
import QuoteTable from "./QuoteTable.jsx";
import ChartSection from "./ChartSection.jsx";
import FundamentalsPanel from "./FundamentalsPanel.jsx";
import StatisticsPanel from "./StatisticsPanel.jsx";
import InsightsPanel from "./InsightsPanel.jsx";
import SummaryBar from "./SummaryBar.jsx";
import ChatPanel from "./ChatPanel.jsx";

const PERIODS = ["1mo", "3mo", "6mo", "1y", "2y", "5y"];
const LS_SYMBOLS = "sae:symbols";
const LS_FOCUSED = "sae:focused";
const POLL_INTERVAL = 30000;

// The full analysis page. `initialSymbols` (from a home-page search) seeds the
// watchlist; otherwise it falls back to the saved/default list.
export default function AnalysisView({ initialSymbols, onHome, theme, toggleTheme }) {
  const [symbolsInput, setSymbolsInput] = useState(
    () => initialSymbols || localStorage.getItem(LS_SYMBOLS) || "AAPL, MSFT, NVDA"
  );
  const [period, setPeriod] = useState("6mo");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [focused, setFocused] = useState(null);
  const [lastPoll, setLastPoll] = useState(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const symbols = symbolsInput
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  // Free real-time prices over Finnhub's WebSocket (client-side).
  const { prices: livePrices, connected: live } = useRealtime(symbols);

  // Merge live trade prices onto the last fetched quotes (prev close stays fixed).
  const displayQuotes = (data?.quotes || []).map((q) => {
    const tick = livePrices[q.symbol];
    if (!tick) return q;
    const prevClose = q.price - q.change;
    const change = tick.price - prevClose;
    return {
      ...q, price: tick.price, change,
      change_pct: prevClose ? (change / prevClose) * 100 : q.change_pct,
      _live: true,
    };
  });

  async function runAnalysis() {
    if (!symbols.length) return;
    setLoading(true);
    setError(null);
    try {
      const result = await analyze(symbols, period);
      setData(result);
      const saved = localStorage.getItem(LS_FOCUSED);
      setFocused(saved && symbols.includes(saved) ? saved : symbols[0] ?? null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { runAnalysis(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { localStorage.setItem(LS_SYMBOLS, symbolsInput); }, [symbolsInput]);
  useEffect(() => { if (focused) localStorage.setItem(LS_FOCUSED, focused); }, [focused]);
  useEffect(() => {
    if (data && focused && !symbols.includes(focused)) setFocused(symbols[0] ?? null);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  function downloadJson() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "analysis.json";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  // Live price polling — refresh quotes every 30s without full re-analysis.
  useEffect(() => {
    if (!data) return;
    const id = setInterval(async () => {
      try {
        const fresh = await quotes(symbols);
        if (fresh.quotes && dataRef.current) {
          setData((prev) => prev ? { ...prev, quotes: fresh.quotes } : prev);
          setLastPoll(new Date());
        }
      } catch { /* silently retry next cycle */ }
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [data, symbols]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>📈 Stock Analysis Engine</h1>
          <p className="sub">Candlesticks · indicators · AI analyst</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="theme-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button className="ghost" onClick={onHome}>← Markets</button>
        </div>
      </header>

      <section className="controls">
        <input
          value={symbolsInput}
          onChange={(e) => setSymbolsInput(e.target.value)}
          placeholder="AAPL, MSFT, NVDA"
          onKeyDown={(e) => e.key === "Enter" && runAnalysis()}
        />
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={runAnalysis} disabled={loading || !symbols.length}>
          {loading ? "Analyzing…" : "Analyze"}
        </button>
        {data && (
          <>
            <a className="download" href={downloadCsvUrl(symbols, period)}>⬇ CSV</a>
            <button className="ghost" onClick={downloadJson}>⬇ JSON</button>
            <button className="ghost" onClick={() => window.print()}>🖨 PDF</button>
          </>
        )}
      </section>
      {data && <p className="muted" style={{ fontSize: "0.78rem", margin: "4px 0 0" }}>
        {live
          ? <><span className="live-dot">● LIVE</span> real-time prices (Finnhub WebSocket)</>
          : <>Quotes refresh every 30s{lastPoll ? ` · updated ${lastPoll.toLocaleTimeString()}` : ""}</>}
      </p>}

      {error && <div className="error">⚠ {error}</div>}

      {data && (
        <>
          <SummaryBar summary={data.summary} />
          <div className="layout">
            <div className="main-col">
              {focused && (
                <ChartSection symbol={focused} onSymbolChange={setFocused} symbols={symbols} />
              )}
              {focused && <FundamentalsPanel symbol={focused} />}
              {focused && <StatisticsPanel symbol={focused} />}
              {focused && <InsightsPanel symbol={focused} />}
              <QuoteTable
                quotes={displayQuotes}
                analyses={data.analyses}
                focused={focused}
                onSelect={setFocused}
              />
            </div>
            <aside className="side-col">
              <ChatPanel symbols={symbols} period={period} />
            </aside>
          </div>
        </>
      )}

      {!data && loading && (
        <div className="layout" style={{ marginTop: 24 }}>
          <div className="main-col">
            <div className="skeleton-summary">
              {[1,2,3,4].map((i) => <div key={i} className="skeleton" />)}
            </div>
            <div className="skeleton skeleton-chart" />
            <div className="skeleton skeleton-table" />
          </div>
          <aside className="side-col">
            <div className="skeleton" style={{ height: 400, borderRadius: 12 }} />
          </aside>
        </div>
      )}
    </div>
  );
}
