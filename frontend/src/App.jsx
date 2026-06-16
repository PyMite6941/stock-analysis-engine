import { useState } from "react";
import { analyze, downloadCsvUrl } from "./api.js";
import QuoteTable from "./components/QuoteTable.jsx";
import PriceChart from "./components/PriceChart.jsx";
import SummaryBar from "./components/SummaryBar.jsx";
import ChatPanel from "./components/ChatPanel.jsx";

const PERIODS = ["1mo", "3mo", "6mo", "1y", "2y", "5y"];

export default function App() {
  const [symbolsInput, setSymbolsInput] = useState("AAPL, MSFT, NVDA");
  const [period, setPeriod] = useState("6mo");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const symbols = symbolsInput
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    try {
      setData(await analyze(symbols, period));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>📈 Stock Analysis Engine</h1>
        <p className="sub">Live data · computed metrics · AI analyst</p>
      </header>

      <section className="controls">
        <input
          value={symbolsInput}
          onChange={(e) => setSymbolsInput(e.target.value)}
          placeholder="AAPL, MSFT, NVDA"
          onKeyDown={(e) => e.key === "Enter" && runAnalysis()}
        />
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIODS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <button onClick={runAnalysis} disabled={loading || !symbols.length}>
          {loading ? "Analyzing…" : "Analyze"}
        </button>
        {data && (
          <a className="download" href={downloadCsvUrl(symbols, period)}>
            ⬇ Download CSV
          </a>
        )}
      </section>

      {error && <div className="error">⚠ {error}</div>}

      {data && (
        <>
          <SummaryBar summary={data.summary} />
          <QuoteTable quotes={data.quotes} analyses={data.analyses} />
          <div className="charts">
            {Object.entries(data.histories).map(([sym, h]) => (
              <PriceChart key={sym} symbol={sym} history={h} />
            ))}
          </div>
          <ChatPanel symbols={symbols} period={period} />
        </>
      )}

      {!data && !loading && (
        <div className="empty">Enter tickers and click <b>Analyze</b> to begin.</div>
      )}
    </div>
  );
}
