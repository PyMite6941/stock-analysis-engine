import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { candles as fetchCandles } from "../api.js";
import CandleChart from "./CandleChart.jsx";
import ComparisonChart from "./ComparisonChart.jsx";
import StatsCompare from "./StatsCompare.jsx";

const TIMEFRAMES = [
  ["1D", "1d", "5m"], ["5D", "5d", "15m"], ["1M", "1mo", "30m"],
  ["3M", "3mo", "3h"], ["6M", "6mo", "3h"], ["1Y", "1y", "1d"],
  ["2Y", "2y", "1wk"], ["5Y", "5y", "1wk"],
];
const INDICATORS = [
  ["sma20", "SMA 20"], ["sma50", "SMA 50"], ["sma200", "SMA 200"],
  ["ema20", "EMA 20"], ["bb", "Bollinger"], ["volume", "Volume"],
  ["rsi", "RSI"], ["macd", "MACD"],
];
const CHART_TYPES = [
  ["area", "Line"], ["candles", "Candles"], ["hollow", "Hollow"],
  ["bars", "OHLC Bars"], ["heikin", "Heikin-Ashi"],
];
const DEFAULT_TOGGLES = {
  sma20: true, sma50: true, sma200: false, ema20: false,
  bb: false, volume: true, rsi: true, macd: true,
};
const DEFAULT_OPTS = { logScale: false, grid: true, crosshair: true };
const LS_TF = "sae:tf";
const LS_TYPE = "sae:chartType";
const LS_IND = "sae:indicators";
const LS_OPTS = "sae:chartOpts";
const LS_DRAW = "sae:drawLevels";

function loadJSON(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") }; }
  catch { return fallback; }
}

export default function ChartSection({ symbol, onSymbolChange, symbols }) {
  const sectionRef = useRef(null);
  const touchX = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [tf, setTf] = useState(() => localStorage.getItem(LS_TF) || "6M");
  const [period, interval] = useMemo(() => {
    const m = TIMEFRAMES.find((t) => t[0] === tf) || TIMEFRAMES[4];
    return [m[1], m[2]];
  }, [tf]);
  const [chartType, setChartType] = useState(() => localStorage.getItem(LS_TYPE) || "area");
  const [opts, setOpts] = useState(() => loadJSON(LS_OPTS, DEFAULT_OPTS));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compare, setCompare] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [toggles, setToggles] = useState(() => loadJSON(LS_IND, DEFAULT_TOGGLES));
  const [drawing, setDrawing] = useState(false);
  const [drawLevels, setDrawLevels] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_DRAW) || "[]"); }
    catch { return []; }
  });

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen();
    }
  }, []);

  useEffect(() => {
    const cb = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", cb);
    return () => document.removeEventListener("fullscreenchange", cb);
  }, []);

  useEffect(() => { localStorage.setItem(LS_TF, tf); }, [tf]);
  useEffect(() => { localStorage.setItem(LS_TYPE, chartType); }, [chartType]);
  useEffect(() => { localStorage.setItem(LS_IND, JSON.stringify(toggles)); }, [toggles]);
  useEffect(() => { localStorage.setItem(LS_OPTS, JSON.stringify(opts)); }, [opts]);
  useEffect(() => { localStorage.setItem(LS_DRAW, JSON.stringify(drawLevels)); }, [drawLevels]);

  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  useEffect(() => {
    if (compare) return;
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

  // Touch swipe — cycle timeframe on horizontal swipe
  const handleTouchStart = (e) => { touchX.current = e.touches[0].clientX; };
  const handleTouchEnd = (e) => {
    if (touchX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    if (Math.abs(dx) > 60) {
      const idx = TIMEFRAMES.findIndex((t) => t[0] === tf);
      if (dx < 0 && idx < TIMEFRAMES.length - 1) setTf(TIMEFRAMES[idx + 1][0]);
      if (dx > 0 && idx > 0) setTf(TIMEFRAMES[idx - 1][0]);
    }
    touchX.current = null;
  };

  return (
    <section className="chart-section"
      ref={sectionRef}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}>
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
          <>
            <select value={chartType} onChange={(e) => setChartType(e.target.value)}>
              {CHART_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <div className="settings-wrap">
              <button className={`ghost ${settingsOpen ? "on" : ""}`}
                      onClick={() => setSettingsOpen((o) => !o)} title="Chart settings">⚙</button>
              {settingsOpen && (
                <div className="settings-pop">
                  <label className="set-row">
                    <span>Price scale</span>
                    <select value={opts.logScale ? "log" : "lin"}
                            onChange={(e) => setOpt("logScale", e.target.value === "log")}>
                      <option value="lin">Linear</option>
                      <option value="log">Log</option>
                    </select>
                  </label>
                  <label className="set-row">
                    <input type="checkbox" checked={opts.grid}
                           onChange={(e) => setOpt("grid", e.target.checked)} />
                    <span>Grid</span>
                  </label>
                  <label className="set-row">
                    <input type="checkbox" checked={opts.crosshair}
                           onChange={(e) => setOpt("crosshair", e.target.checked)} />
                    <span>Crosshair</span>
                  </label>
                </div>
              )}
            </div>
            <button className={`ghost ${drawing ? "on" : ""}`}
                    onClick={() => setDrawing((d) => !d)} title="Drawing mode">
              ✏ {drawing ? "Drawing" : "Draw"}
            </button>
          </>
        )}
        <button className={`ghost ${compare ? "on" : ""}`}
                onClick={() => setCompare((c) => !c)}
                disabled={!compare && symbols.length < 2}
                title={symbols.length < 2 ? "Add 2+ tickers to compare" : ""}>
          {compare ? "← Single" : "⇄ Compare"}
        </button>
        <button className="ghost" onClick={toggleFullscreen} title="Fullscreen">
          {fullscreen ? "⊠" : "⛶"}
        </button>
        {loading && <span className="muted">loading…</span>}
      </div>

      {compare ? (
        <>
          <ComparisonChart symbols={symbols} period={period} interval={interval} />
          <StatsCompare symbols={symbols} />
        </>
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
            {drawLevels.length > 0 && (
              <button className="tog" style={{ color: "var(--neg)", borderColor: "var(--neg)" }}
                      onClick={() => setDrawLevels([])}>✕ clear levels</button>
            )}
          </div>
          {error && <div className="error">⚠ {error}</div>}
          {data && data.dates?.length ? (
            <CandleChart data={data} toggles={toggles}
                         settings={{ type: chartType, ...opts }}
                         drawing={drawing} drawLevels={drawLevels}
                         onAddLevel={(price) => setDrawLevels((prev) => {
                           const exists = prev.some((l) => Math.abs(l.price - price) < 0.01);
                           return exists ? prev : [...prev, { price, color: "#f0b90b" }];
                         })} />
          ) : (
            !loading && <div className="muted chart-empty">No candle data for {symbol}.</div>
          )}
        </>
      )}
    </section>
  );
}
