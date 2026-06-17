import { useState, useEffect, useMemo } from "react";
import { candles as fetchCandles } from "../api.js";
import CandleChart from "./CandleChart.jsx";

// label -> [period, interval]. 1D/5D are intraday (hourly / 3-hour bars).
const TIMEFRAMES = [
  ["1D", "1d", "1h"],
  ["5D", "5d", "3h"],
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

// Controlled `symbol` so clicking a watchlist row drives this chart.
export default function ChartSection({ symbol, onSymbolChange, symbols }) {
  const [tf, setTf] = useState("6M");
  const [period, interval] = useMemo(() => {
    const m = TIMEFRAMES.find((t) => t[0] === tf) || TIMEFRAMES[4];
    return [m[1], m[2]];
  }, [tf]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [toggles, setToggles] = useState({
    sma20: true, sma50: true, sma200: false, ema20: false,
    bb: false, volume: true, rsi: true, macd: true,
  });

  useEffect(() => {
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
  }, [symbol, period, interval]);

  const toggle = (key) => setToggles((t) => ({ ...t, [key]: !t[key] }));

  return (
    <section className="chart-section">
      <div className="chart-controls">
        <select value={symbol} onChange={(e) => onSymbolChange(e.target.value)}>
          {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="seg">
          {TIMEFRAMES.map(([label]) => (
            <button key={label} className={label === tf ? "on" : ""}
                    onClick={() => setTf(label)}>{label}</button>
          ))}
        </div>
        {loading && <span className="muted">loading…</span>}
      </div>

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
        <CandleChart data={data} toggles={toggles} />
      ) : (
        !loading && <div className="muted chart-empty">No candle data for {symbol}.</div>
      )}
    </section>
  );
}
