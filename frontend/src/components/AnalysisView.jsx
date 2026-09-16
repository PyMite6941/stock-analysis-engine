import { useState, useEffect, useRef } from "react";
import { analyze, quotes, downloadCsvUrl, downloadXlsxUrl, holdings as fetchHoldings } from "../api.js";
import { useRealtime } from "../useRealtime.js";
import { getMode, isHidden } from "../modes.js";
import { loadPositions, savePositions } from "../positions.js";
import QuoteTable from "./QuoteTable.jsx";
import ChartSection from "./ChartSection.jsx";
import FundamentalsPanel from "./FundamentalsPanel.jsx";
import StatisticsPanel from "./StatisticsPanel.jsx";
import InsightsPanel from "./InsightsPanel.jsx";
import SummaryBar from "./SummaryBar.jsx";
import ChatPanel from "./ChatPanel.jsx";
import ModeSwitch from "./ModeSwitch.jsx";
import ForecastPanel from "./ForecastPanel.jsx";
import DayTradePanel from "./DayTradePanel.jsx";
import HoldingsPanel from "./HoldingsPanel.jsx";
import PositionsPanel from "./PositionsPanel.jsx";
import ComparePanel from "./ComparePanel.jsx";
import BeginnerBrief from "./BeginnerBrief.jsx";

const PERIODS = ["1mo", "3mo", "6mo", "1y", "2y", "5y"];
const LS_SYMBOLS = "sae:symbols";
const LS_FOCUSED = "sae:focused";
const POLL_INTERVAL = 30000;

// The full analysis page. `initialSymbols` (from a home-page search) seeds the
// watchlist; otherwise it falls back to the saved/default list.
export default function AnalysisView({ initialSymbols, onHome, theme, toggleTheme,
                                       mode, setMode }) {
  const [symbolsInput, setSymbolsInput] = useState(
    () => initialSymbols || localStorage.getItem(LS_SYMBOLS) || "AAPL, MSFT, NVDA"
  );
  const [period, setPeriod] = useState("6mo");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(null);   // bad ticker, not a failure
  const [focused, setFocused] = useState(null);
  const [lastPoll, setLastPoll] = useState(null);
  const [positions, setPositionsState] = useState(loadPositions);
  const [fund, setFund] = useState(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const cfg = getMode(mode);
  const beginner = mode === "beginner";

  const symbols = symbolsInput
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  // Watch the symbols on screen plus anything held, so live P/L keeps ticking
  // even when the holding isn't in the current watchlist.
  const watched = [...new Set([...symbols, ...positions.map((p) => p.symbol)])];
  const { prices: livePrices, connected: live } = useRealtime(watched);

  function setPositions(next) {
    setPositionsState(Array.isArray(next) ? next : loadPositions());
  }

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
    setNotFound(null);
    try {
      const result = await analyze(symbols, period);
      setData(result);
      // Some symbols resolved, some didn't — show the good ones and name the bad.
      setNotFound(result.not_found?.length ? result.not_found : null);
      const saved = localStorage.getItem(LS_FOCUSED);
      const good = result.quotes.map((q) => q.symbol);
      setFocused(saved && good.includes(saved) ? saved : good[0] ?? null);
    } catch (e) {
      // A typo'd ticker is its own message, not a generic request failure.
      if (e.notFound) {
        setNotFound([e.symbol || symbolsInput]);
        setError(null);
        setData(null);
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { runAnalysis(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { localStorage.setItem(LS_SYMBOLS, symbolsInput); }, [symbolsInput]);
  useEffect(() => { if (focused) localStorage.setItem(LS_FOCUSED, focused); }, [focused]);
  useEffect(() => { savePositions(positions); }, [positions]);
  useEffect(() => {
    if (data && focused && !symbols.includes(focused)) setFocused(symbols[0] ?? null);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Is the focused symbol a fund? Beginner brief and panel ordering both care.
  useEffect(() => {
    let cancelled = false;
    setFund(null);
    if (!focused) return;
    fetchHoldings(focused)
      .then((d) => { if (!cancelled) setFund(d); })
      .catch(() => { /* non-fatal: the panel just won't render */ });
    return () => { cancelled = true; };
  }, [focused]);

  function focusSymbol(sym) {
    const s = String(sym).toUpperCase();
    setFocused(s);
    if (!symbols.includes(s)) setSymbolsInput([...symbols, s].join(", "));
  }

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

  const focusedQuote = displayQuotes.find((q) => q.symbol === focused);
  const focusedAnalysis = data?.analyses?.find((a) => a.symbol === focused);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>📈 Stock Analysis Engine</h1>
          <p className="sub">{cfg.tagline}</p>
        </div>
        <div className="header-actions">
          <ModeSwitch mode={mode} onChange={setMode} />
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
            <a className="download" href={downloadXlsxUrl(symbols, period)}>⬇ Excel</a>
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

      {notFound && (
        <div className="not-found-banner">
          <strong>🔎 Stock/ETF not found:</strong>{" "}
          <code>{notFound.join(", ")}</code>
          <span> — check the ticker symbol. Use the exchange ticker (AAPL, not
            Apple), and ^GSPC-style symbols for indices.</span>
        </div>
      )}
      {error && <div className="error">⚠ {error}</div>}

      <div className="disclaimer">
        <strong>⚠</strong>
        <span>Not financial advice. Past performance does not guarantee future results.
        Data may be delayed. Verify all information before making investment decisions.</span>
      </div>

      {data && (
        <>
          <SummaryBar summary={data.summary} />
          <div className="layout">
            <div className="main-col">
              {beginner && focusedQuote && (
                <BeginnerBrief quote={focusedQuote} analysis={focusedAnalysis} fund={fund} />
              )}

              {focused && (
                <ChartSection symbol={focused} onSymbolChange={setFocused} symbols={symbols} />
              )}

              {mode === "daytrader" && focused && (
                <DayTradePanel symbol={focused} livePrice={livePrices[focused]?.price} />
              )}

              <PositionsPanel
                beginner={beginner}
                livePrices={livePrices}
                positions={positions}
                setPositions={setPositions}
                onSelect={focusSymbol}
              />

              <ComparePanel
                positions={positions}
                setPositions={setPositions}
                beginner={beginner}
                onSelect={focusSymbol}
              />

              {focused && <ForecastPanel symbol={focused} beginner={beginner} />}

              {focused && <HoldingsPanel symbol={focused} beginner={beginner}
                                         onSelect={focusSymbol} />}

              {focused && <FundamentalsPanel symbol={focused} />}
              {focused && !isHidden(mode, "statistics") && <StatisticsPanel symbol={focused} />}
              {focused && <InsightsPanel symbol={focused} />}

              <QuoteTable
                quotes={displayQuotes}
                analyses={data.analyses}
                focused={focused}
                onSelect={setFocused}
              />
            </div>
            <aside className="side-col">
              <ChatPanel symbols={symbols} period={period} mode={mode}
                         positions={positions} focused={focused} />
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

      {!data && !loading && notFound && (
        <PositionsPanel
          beginner={beginner}
          livePrices={livePrices}
          positions={positions}
          setPositions={setPositions}
          onSelect={focusSymbol}
        />
      )}
    </div>
  );
}
