import { useState, useEffect, useRef } from "react";
import { analyze, quotes, asset as fetchAsset, holdings as fetchHoldings,
         searchSymbols } from "../api.js";
import { useRealtime } from "../useRealtime.js";
import { allContinuous } from "../market.js";
import { getMode, isHidden } from "../modes.js";
import { loadPositions, savePositions } from "../positions.js";
import { addSales, loadSales, saveSales } from "../sales.js";
import {
  evaluate as evaluateAlerts, loadAlerts, loadFired, notify, recordFired,
  symbolsOf as alertSymbols,
} from "../alerts.js";
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
import ExportMenu from "./ExportMenu.jsx";
import BacktestPanel from "./BacktestPanel.jsx";
import IncomePanel from "./IncomePanel.jsx";
import CorrelationPanel from "./CorrelationPanel.jsx";
import PortfolioForecastPanel from "./PortfolioForecastPanel.jsx";
import AlertsPanel from "./AlertsPanel.jsx";
import RealizedPanel from "./RealizedPanel.jsx";
import PriceClock from "./PriceClock.jsx";
import RiskPanel from "./RiskPanel.jsx";
import TaxPanel from "./TaxPanel.jsx";
import EventsPanel from "./EventsPanel.jsx";
import RiskCalculator from "./RiskCalculator.jsx";
import PaperTradePanel from "./PaperTradePanel.jsx";
import { backendAvailable } from "../runtime.js";

// Window used for the analysis fetch and the AI context. The chart and the
// gain/loss panel each carry their own timeframe picker, so a third selector
// in the controls bar changed nothing visible and only confused people.
const DEFAULT_PERIOD = "6mo";
const LS_SYMBOLS = "sae:symbols";
const LS_FOCUSED = "sae:focused";
const POLL_INTERVAL = 30000;
const LS_TAB = "sae:tab";

const VIEW_TABS = [
  { id: "overview", icon: "📋", label: "Overview",
    hint: "Your watchlist, key stats and the latest news." },
  { id: "trade", icon: "⚡", label: "Trade",
    hint: "How many shares to buy, practice trades, and intraday levels." },
  { id: "portfolio", icon: "💼", label: "Portfolio",
    hint: "What you own: gains, dividends, taxes and risk." },
  { id: "research", icon: "🔬", label: "Research",
    hint: "Forecasts, backtests, fund holdings and valuation." },
];
// Where each audience lands: day traders straight on the Trade tab.
const TAB_FOR_MODE = { beginner: "overview", standard: "overview", daytrader: "trade" };

// The full analysis page. `initialSymbols` (from a home-page search) seeds the
// watchlist; otherwise it falls back to the saved/default list.
export default function AnalysisView({ initialSymbols, onHome, theme, toggleTheme,
                                       mode, setMode, onStartTour }) {
  const [symbolsInput, setSymbolsInput] = useState(
    () => initialSymbols || localStorage.getItem(LS_SYMBOLS) || "AAPL, MSFT, NVDA"
  );
  const [period] = useState(DEFAULT_PERIOD);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(null);   // bad ticker, not a failure
  const [focused, setFocused] = useState(null);
  const [lastPoll, setLastPoll] = useState(null);
  const [positions, setPositionsState] = useState(loadPositions);
  const [sales, setSalesState] = useState(loadSales);
  const [alerts, setAlerts] = useState(loadAlerts);
  const [fired, setFired] = useState(loadFired);
  const [fund, setFund] = useState(null);
  const [assetInfo, setAssetInfo] = useState(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const cfg = getMode(mode);
  const beginner = mode === "beginner";
  const server = backendAvailable();

  // The open tab is remembered, but switching mode jumps to that mode's home.
  const [tab, setTab] = useState(() => {
    try {
      const saved = localStorage.getItem(LS_TAB);
      if (VIEW_TABS.some((t) => t.id === saved)) return saved;
    } catch { /* storage blocked */ }
    return TAB_FOR_MODE[mode] || "overview";
  });
  const pickTab = (id) => {
    setTab(id);
    try { localStorage.setItem(LS_TAB, id); } catch { /* storage blocked */ }
  };
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) { firstMode.current = false; return; }
    pickTab(TAB_FOR_MODE[mode] || "overview");
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const symbols = symbolsInput
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  // Watch the symbols on screen plus anything held, so live P/L keeps ticking
  // even when the holding isn't in the current watchlist.
  const watched = [...new Set([...symbols, ...positions.map((p) => p.symbol),
                              ...alertSymbols(alerts)])];
  const { prices: livePrices, connected: live, lastTick } =
    useRealtime(watched);

  function setPositions(next) {
    setPositionsState(Array.isArray(next) ? next : loadPositions());
  }

  function setSales(next) {
    setSalesState(Array.isArray(next) ? next : loadSales());
  }

  // A sale produces realised rows; record them so the realised panel picks
  // them up without a second round trip.
  function handleSold(realizedRows) {
    if (realizedRows?.length) setSalesState(addSales(loadSales(), realizedRows));
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
      // Company names work here too, not just on the home page: someone who
      // edits this box to "tesla" should get TSLA rather than a 404.
      let wanted = symbols;
      const looksLikeName = (s) => /[a-z]/i.test(s) && (s.includes(" ") || s.length > 5);
      if (symbols.some(looksLikeName)) {
        wanted = await Promise.all(symbols.map(async (s) => {
          if (!looksLikeName(s)) return s;
          try {
            const hit = (await searchSymbols(s, 1)).results?.[0];
            return hit ? hit.symbol : s;
          } catch { return s; }
        }));
        if (wanted.join(",") !== symbols.join(",")) {
          setSymbolsInput(wanted.join(", "));
        }
      }
      const result = await analyze(wanted, period);
      setData(result);
      // This IS a price fetch, so it dates the quotes on screen. Without it the
      // clock reads "waiting for prices" while showing prices, until the 30s
      // poll first fires.
      setLastPoll(new Date());
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
  useEffect(() => { saveSales(sales); }, [sales]);
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

  // What kind of instrument is this? Crypto has no P/E, a mutual fund has no
  // intraday session — panels ask this rather than guessing from the ticker.
  useEffect(() => {
    let cancelled = false;
    setAssetInfo(null);
    if (!focused) return;
    fetchAsset(focused)
      .then((d) => { if (!cancelled) setAssetInfo(d); })
      .catch(() => { /* fall back to the equity assumptions */ });
    return () => { cancelled = true; };
  }, [focused]);

  function focusSymbol(sym) {
    const s = String(sym).toUpperCase();
    setFocused(s);
    if (!symbols.includes(s)) setSymbolsInput([...symbols, s].join(", "));
  }

  // Check alerts whenever prices move. This piggybacks on data the page is
  // already fetching, which is what makes alerts free — and also why they only
  // work while a tab is open.
  useEffect(() => {
    if (!alerts.length) return;
    const quoteMap = {};
    for (const q of displayQuotes) quoteMap[q.symbol] = q;
    // Live ticks cover symbols that aren't in the current analysis.
    for (const [sym, tick] of Object.entries(livePrices)) {
      if (!quoteMap[sym] && tick?.price) quoteMap[sym] = { price: tick.price };
    }
    if (!Object.keys(quoteMap).length) return;

    const { triggered, alerts: updated } = evaluateAlerts(alerts, {
      quotes: quoteMap,
      // Only positions we can actually price. Passing market_value 0 for an
      // unpriced holding made it look like a total loss, so every
      // "position loses X%" alert fired instantly and falsely for anything
      // not in the current watchlist.
      positionRows: positions
        .filter((p) => quoteMap[p.symbol]?.price)
        .map((p) => ({
          symbol: p.symbol,
          cost: p.shares * p.cost_basis,
          market_value: p.shares * quoteMap[p.symbol].price,
        })),
    });
    if (!triggered.length) return;
    triggered.forEach(notify);
    setFired(recordFired(triggered));
    setAlerts(updated);
  }, [livePrices, data, alerts]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <button className="help-btn" onClick={onStartTour}
                  title="Show me around" aria-label="Show me around">?</button>
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
        <button onClick={runAnalysis} disabled={loading || !symbols.length}>
          {loading ? "Analyzing…" : "Analyze"}
        </button>
        <ExportMenu symbols={symbols} positions={positions} sales={sales}
                    period={period} data={data} />
      </section>
      {data && (
        <PriceClock
          lastTick={lastTick}
          lastPoll={lastPoll ? lastPoll.getTime() : null}
          streaming={live}
          continuous={allContinuous(watched)}
        />
      )}

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

              {assetInfo && assetInfo.asset_class !== "equity" && (
                <p className="asset-note">
                  <span className={`asset-badge ${assetInfo.asset_class}`}>
                    {assetInfo.label}
                  </span>
                  <span>
                    {focused} trades {assetInfo.trades}.
                    {!assetInfo.pe && " No P/E — it has no earnings."}
                    {!assetInfo.volume && " No share volume."}
                    {!assetInfo.intraday && " Priced once a day, so there are no intraday charts."}
                  </span>
                </p>
              )}

              {/* Everything below the chart lives in tabs, like Yahoo's
                  Summary / Statistics / Holders row: each thing has one
                  obvious home, and panels in hidden tabs don't load at all. */}
              <nav className="view-tabs" role="tablist" aria-label="Sections">
                {VIEW_TABS.map((t) => (
                  <button key={t.id} role="tab" aria-selected={tab === t.id}
                          className={tab === t.id ? "on" : ""} onClick={() => pickTab(t.id)}>
                    <span aria-hidden="true">{t.icon}</span> {t.label}
                  </button>
                ))}
              </nav>
              <p className="view-tab-hint">{VIEW_TABS.find((t) => t.id === tab).hint}</p>

              {!server && (tab === "portfolio" || tab === "research") && (
                <p className="direct-note">
                  ℹ This copy of the site runs without a server, so the panels
                  that need one ({tab === "portfolio"
                    ? "gains, taxes, income, risk and correlation"
                    : "forecasts, backtests, fund holdings and valuation"}) are hidden.
                </p>
              )}

              {tab === "overview" && (
                <>
                  <QuoteTable
                    quotes={displayQuotes}
                    analyses={data.analyses}
                    focused={focused}
                    onSelect={setFocused}
                  />
                  {server && focused && <FundamentalsPanel symbol={focused} />}
                  {server && focused && <InsightsPanel symbol={focused} />}
                </>
              )}

              {tab === "trade" && (
                <>
                  {server && mode === "daytrader" && focused && (
                    <DayTradePanel symbol={focused} livePrice={livePrices[focused]?.price} />
                  )}
                  {/* The intraday panel carries its own sizer; don't show two. */}
                  {!(server && mode === "daytrader") && (
                    <RiskCalculator symbol={focused} beginner={beginner}
                                    livePrice={livePrices[focused]?.price ?? focusedQuote?.price} />
                  )}
                  <PaperTradePanel symbol={focused} beginner={beginner}
                                   price={livePrices[focused]?.price ?? focusedQuote?.price}
                                   livePrices={livePrices} onSelect={focusSymbol} />
                </>
              )}

              {tab === "portfolio" && (
                <>
                  {server && <EventsPanel positions={positions} symbols={symbols}
                                          beginner={beginner} onSelect={focusSymbol} />}

                  <PositionsPanel
                    beginner={beginner}
                    livePrices={livePrices}
                    positions={positions}
                    setPositions={setPositions}
                    onSelect={focusSymbol}
                    onSold={handleSold}
                    focusedSymbol={focused}
                  />

                  {server && (
                    <>
                      <RealizedPanel
                        sales={sales}
                        setSales={setSales}
                        positions={positions}
                        beginner={beginner}
                        onSelect={focusSymbol}
                      />

                      <TaxPanel sales={sales} positions={positions}
                                beginner={beginner} />

                      <IncomePanel positions={positions} beginner={beginner}
                                   onSelect={focusSymbol} />

                      <PortfolioForecastPanel positions={positions} beginner={beginner} />

                      <RiskPanel positions={positions} beginner={beginner}
                                 onSelect={focusSymbol} />

                      <CorrelationPanel positions={positions} beginner={beginner}
                                        onSelect={focusSymbol} />

                      <ComparePanel
                        positions={positions}
                        setPositions={setPositions}
                        beginner={beginner}
                        onSelect={focusSymbol}
                      />
                    </>
                  )}
                </>
              )}

              {tab === "research" && server && focused && (
                <>
                  <ForecastPanel symbol={focused} beginner={beginner} />
                  {!beginner && <BacktestPanel symbol={focused} beginner={beginner} />}
                  <HoldingsPanel symbol={focused} beginner={beginner}
                                 onSelect={focusSymbol} />
                  {!isHidden(mode, "statistics") && <StatisticsPanel symbol={focused} />}
                </>
              )}
            </div>
            <aside className="side-col">
              <AlertsPanel alerts={alerts} setAlerts={setAlerts}
                           fired={fired} setFired={setFired}
                           symbols={watched} focused={focused} />
              {server ? (
                <ChatPanel symbols={symbols} period={period} mode={mode}
                           positions={positions} focused={focused} />
              ) : (
                <p className="direct-note">
                  🤖 The AI analyst needs a server to keep its key secret, so it's
                  off in this copy of the site.
                </p>
              )}
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
          onSold={handleSold}
        />
      )}
    </div>
  );
}
