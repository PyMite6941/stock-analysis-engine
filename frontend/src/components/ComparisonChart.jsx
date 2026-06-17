import { useEffect, useRef, useState } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import { candles as fetchCandles } from "../api.js";

const COLORS = ["#42a5f5", "#f0b90b", "#26a69a", "#ef5350", "#ab47bc",
                "#26c6da", "#ff7043", "#9ccc65"];

function toTime(d) {
  return d.includes(" ")
    ? Math.floor(Date.parse(d.replace(" ", "T") + "Z") / 1000)
    : d;
}

// Yahoo-style comparison: every series normalized to % change from its first
// point, so differently-priced tickers are visually comparable on one axis.
export default function ComparisonChart({ symbols, period, interval }) {
  const ref = useRef(null);
  const [series, setSeries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const results = await Promise.all(
          symbols.map((s) =>
            fetchCandles(s, period, interval).then((d) => ({ s, d })).catch(() => ({ s, d: null })))
        );
        if (cancelled) return;
        const out = [];
        results.forEach(({ s, d }, idx) => {
          if (!d || !d.close?.length) return;
          const base = d.close.find((v) => v != null);
          if (!base) return;
          const points = [];
          for (let i = 0; i < d.dates.length; i++) {
            const v = d.close[i];
            if (v != null) points.push({ time: toTime(d.dates[i]), value: (v / base - 1) * 100 });
          }
          out.push({
            symbol: s, points, color: COLORS[idx % COLORS.length],
            lastPct: points.length ? points.at(-1).value : 0,
          });
        });
        setSeries(out);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (symbols.length) load();
    return () => { cancelled = true; };
  }, [symbols.join(","), period, interval]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ref.current || !series.length) return;
    const intraday = typeof series[0].points[0]?.time === "number";
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { color: "#0d1117" }, textColor: "#8b949e" },
      grid: { vertLines: { color: "#161b22" }, horzLines: { color: "#161b22" } },
      timeScale: { borderColor: "#30363d", timeVisible: intraday, secondsVisible: false },
      rightPriceScale: { borderColor: "#30363d" },
      crosshair: { mode: 1 },
    });
    series.forEach((s) => {
      const ls = chart.addSeries(LineSeries, {
        color: s.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
        priceFormat: { type: "custom", minMove: 0.01, formatter: (p) => `${p.toFixed(2)}%` },
      });
      ls.setData(s.points);
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series]);

  return (
    <div>
      <div className="compare-legend">
        {series.map((s) => (
          <span key={s.symbol} className="cl-item">
            <span className="cl-dot" style={{ background: s.color }} />
            {s.symbol}{" "}
            <b className={s.lastPct >= 0 ? "pos" : "neg"}>
              {s.lastPct >= 0 ? "+" : ""}{s.lastPct.toFixed(2)}%
            </b>
          </span>
        ))}
      </div>
      {error && <div className="error">⚠ {error}</div>}
      {loading && !series.length && <div className="muted chart-empty">Loading comparison…</div>}
      <div ref={ref} className="candle-chart" />
    </div>
  );
}
