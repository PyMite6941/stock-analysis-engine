import { useState, useEffect } from "react";
import { analyze, downloadCsvUrl } from "./api.js";
import QuoteTable from "./components/QuoteTable.jsx";
import ChartSection from "./components/ChartSection.jsx";
import FundamentalsPanel from "./components/FundamentalsPanel.jsx";
import SummaryBar from "./components/SummaryBar.jsx";
import ChatPanel from "./components/ChatPanel.jsx";

const PERIODS = ["1mo", "3mo", "6mo", "1y", "2y", "5y"];

// Watchlist + focused symbol persist in localStorage so the page remembers
// your tickers between visits.
const LS_SYMBOLS = "sae:symbols";
const LS_FOCUSED = "sae:focused";

export default function App() {
  const [symbolsInput, setSymbolsInput] = useState(
    () => localStorage.getItem(LS_SYMBOLS) || "AAPL, MSFT, NVDA"
  );
  const [period, setPeriod] = useState("6mo");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [focused, setFocused] = useState(null); // symbol shown in the big chart

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
      // Restore the last focused symbol if it's still in the list.
      const saved = localStorage.getItem(LS_FOCUSED);
      setFocused(saved && symbols.includes(saved) ? saved : symbols[0] ?? null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Auto-load the saved/default watchlist on first visit so the page opens to a chart.
  useEffect(() => { runAnalysis(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist watchlist + focused symbol.
  useEffect(() => { localStorage.setItem(LS_SYMBOLS, symbolsInput); }, [symbolsInput]);
  useEffect(() => { if (focused) localStorage.setItem(LS_FOCUSED, focused); }, [focused]);

  // Keep the focused chart symbol valid as the watchlist changes.
  useEffect(() => {
    if (data && focused && !symbols.includes(focused)) setFocused(symbols[0] ?? null);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <header>
        <h1>📈 Stock Analysis Engine</h1>
        <p className="sub">Candlesticks · indicators · AI analyst — a free, lean charting tool</p>
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

      {!data && !loading && (
        <div className="empty">Enter tickers and click <b>Analyze</b> to begin.</div>
      )}
    </div>
  );
}
