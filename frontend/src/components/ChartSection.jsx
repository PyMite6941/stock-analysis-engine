import { useState, useEffect, useMemo } from "react";
import { candles as fetchCandles } from "../api.js";
import CandleChart from "./CandleChart.jsx";
import ComparisonChart from "./ComparisonChart.jsx";

// label -> [period, interval]. 1D/5D use fine intraday bars for Yahoo-like density.
const TIMEFRAMES = [
  ["1D", "1d", "2m"],
  ["5D", "5d", "15m"],
  ["1M", "1mo", "1d"],
  ["3M", "3mo", "1d"],
  ["6M", "6mo", "1d"],
  ["1Y", "1y", "1d"],
  ["2Y", "2y", "1wk"],
  ["5Y", "5y", "1wk"],
];
const INDICATORS = [
  ["sma20", "SMA 20"], ["sma50", "SMA 50"], ["sma200", "SMA 200"],
  ["ema20", "EMA 20"], ["bb", "Bollinger"], ["volume", "Volume"],
  ["rsi", "RSI"], ["macd", "MACD"],
];
const DEFAULT_TOGGLES = {
  sma20: true, sma50: true, sma200: false, ema20: false,
  bb: false, volume: true, rsi: true, macd: true,
};
// Chart preferences persist between visits, like the watchlist.
const LS_TF = "sae:tf";
const LS_TYPE = "sae:chartType";
const LS_IND = "sae:indicators";

function loadToggles() {
  try {
    return { ...DEFAULT_TOGGLES, ...JSON.parse(localStorage.getItem(LS_IND) || "{}") };
  } catch {
    return DEFAULT_TOGGLES;
  }
}

// Controlled `symbol` so clicking a watchlist row drives this chart.
export default function ChartSection({ symbol, onSymbolChange, symbols }) {
  const [tf, setTf] = useState(() => localStorage.getItem(LS_TF) || "6M");
  const [period, interval] = useMemo(() => {
    const m = TIMEFRAMES.find((t) => t[0] === tf) || TIMEFRAMES[4];
    return [m[1], m[2]];
  }, [tf]);
  const [chartType, setChartType] = useState(() => localStorage.getItem(LS_TYPE) || "area");
  const [compare, setCompare] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [toggles, setToggles] = useState(loadToggles);

  // Persist chart preferences.
  useEffect(() => { localStorage.setItem(LS_TF, tf); }, [tf]);
  useEffect(() => { localStorage.setItem(LS_TYPE, chartType); }, [chartType]);
  useEffect(() => { localStorage.setItem(LS_IND, JSON.stringify(toggles)); }, [toggles]);

  useEffect(() => {
    if (compare) return; // comparison chart fetches its own data
    let cancelled = false;
    async function load() {
      if (!symbol) return;
      setLoading(true);
      setError(null);
      try {
        const d = await fetchCandles(symbol, period, interval);
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [symbol, period, interval, compare]);

  const toggle = (key) => setToggles((t) => ({ ...t, [key]: !t[key] }));

  return (
    <section className="chart-section">
      <div className="chart-controls">
        {!compare && (
          <select value={symbol} onChange={(e) => onSymbolChange(e.target.value)}>
            {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <div className="seg">
          {TIMEFRAMES.map(([label]) => (
            <button key={label} className={label === tf ? "on" : ""}
                    onClick={() => setTf(label)}>{label}</button>
          ))}
        </div>
        {!compare && (
          <div className="seg">
            <button className={chartType === "area" ? "on" : ""}
                    onClick={() => setChartType("area")}>Line</button>
            <button className={chartType === "candles" ? "on" : ""}
                    onClick={() => setChartType("candles")}>Candles</button>
          </div>
        )}
        <button className={`ghost ${compare ? "on" : ""}`}
                onClick={() => setCompare((c) => !c)}
                disabled={!compare && symbols.length < 2}
                title={symbols.length < 2 ? "Add 2+ tickers to compare" : ""}>
          {compare ? "← Single" : "⇄ Compare"}
        </button>
        {loading && <span className="muted">loading…</span>}
      </div>

      {compare ? (
        <ComparisonChart symbols={symbols} period={period} interval={interval} />
      ) : (
        <>
          <div className="indicator-toggles">
            {INDICATORS.map(([key, label]) => (
              <label key={key} className={`tog ${toggles[key] ? "on" : ""}`}>
                <input type="checkbox" checked={toggles[key]}
                       onChange={() => toggle(key)} />
                {label}
              </label>
            ))}
          </div>
          {error && <div className="error">⚠ {error}</div>}
          {data && data.dates?.length ? (
            <CandleChart data={data} toggles={toggles} chartType={chartType} />
          ) : (
            !loading && <div className="muted chart-empty">No candle data for {symbol}.</div>
          )}
        </>
      )}
    </section>
  );
}
