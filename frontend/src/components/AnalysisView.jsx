import { useState, useEffect } from "react";
import { analyze, downloadCsvUrl } from "../api.js";
import QuoteTable from "./QuoteTable.jsx";
import ChartSection from "./ChartSection.jsx";
import FundamentalsPanel from "./FundamentalsPanel.jsx";
import SummaryBar from "./SummaryBar.jsx";
import ChatPanel from "./ChatPanel.jsx";

const PERIODS = ["1mo", "3mo", "6mo", "1y", "2y", "5y"];
const LS_SYMBOLS = "sae:symbols";
const LS_FOCUSED = "sae:focused";

// The full analysis page. `initialSymbols` (from a home-page search) seeds the
// watchlist; otherwise it falls back to the saved/default list.
export default function AnalysisView({ initialSymbols, onHome }) {
  const [symbolsInput, setSymbolsInput] = useState(
    () => initialSymbols || localStorage.getItem(LS_SYMBOLS) || "AAPL, MSFT, NVDA"
  );
  const [period, setPeriod] = useState("6mo");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [focused, setFocused] = useState(null);

  const symbols = symbolsInput
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

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

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>📈 Stock Analysis Engine</h1>
          <p className="sub">Candlesticks · indicators · AI analyst</p>
        </div>
        <button className="ghost" onClick={onHome}>← Markets</button>
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
          <a className="download" href={downloadCsvUrl(symbols, period)}>⬇ Download CSV</a>
        )}
      </section>

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
              <QuoteTable
                quotes={data.quotes}
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

      {!data && loading && <div className="empty">Loading…</div>}
    </div>
  );
}
