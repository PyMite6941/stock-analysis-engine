import { useEffect, useRef } from "react";
import {
  createChart, CandlestickSeries, LineSeries, HistogramSeries,
} from "lightweight-charts";

// lightweight-charts wants either a 'YYYY-MM-DD' business-day string or a UNIX
// timestamp (seconds). Intraday dates carry a time, so convert those.
function toTime(d) {
  return d.includes(" ")
    ? Math.floor(Date.parse(d.replace(" ", "T") + "Z") / 1000)
    : d;
}

// Map an indicator array (with Nones in the warm-up) to chart points.
function lineData(dates, arr) {
  if (!arr) return [];
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    if (arr[i] != null) out.push({ time: toTime(dates[i]), value: arr[i] });
  }
  return out;
}

export default function CandleChart({ data, toggles }) {
  const ref = useRef(null);

  // Full rebuild whenever the data or the indicator toggles change. The chart is
  // light enough that recreating it is simpler and less bug-prone than juggling
  // add/remove of individual panes and series.
  useEffect(() => {
    if (!ref.current || !data?.dates?.length) return;
    const intraday = data.dates[0].includes(" ");
    const t = (i) => toTime(data.dates[i]);

    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { color: "#0d1117" },
        textColor: "#8b949e",
        panes: { separatorColor: "#30363d", separatorHoverColor: "#444" },
      },
      grid: { vertLines: { color: "#161b22" }, horzLines: { color: "#161b22" } },
      timeScale: { borderColor: "#30363d", timeVisible: intraday },
      rightPriceScale: { borderColor: "#30363d" },
      crosshair: { mode: 1 },
    });

    // --- Pane 0: candles + overlays ---
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a", downColor: "#ef5350", borderVisible: false,
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    }, 0);
    candle.setData(data.dates.map((d, i) => ({
      time: t(i), open: data.open[i], high: data.high[i],
      low: data.low[i], close: data.close[i],
    })));

    const ind = data.indicators || {};
    const overlay = (arr, color) => {
      const s = chart.addSeries(LineSeries, {
        color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false,
      }, 0);
      s.setData(lineData(data.dates, arr));
    };
    if (toggles.sma20) overlay(ind.sma20, "#f0b90b");
    if (toggles.sma50) overlay(ind.sma50, "#42a5f5");
    if (toggles.sma200) overlay(ind.sma200, "#ab47bc");
    if (toggles.ema20) overlay(ind.ema20, "#26c6da");
    if (toggles.bb) {
      overlay(ind.bb_upper, "#6b7280");
      overlay(ind.bb_mid, "#4b5563");
      overlay(ind.bb_lower, "#6b7280");
    }

    // --- Lower panes ---
    let pane = 1;
    if (toggles.volume) {
      const vol = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" }, priceLineVisible: false,
      }, pane);
      vol.setData(data.dates.map((d, i) => ({
        time: t(i), value: data.volume[i],
        color: data.close[i] >= data.open[i]
          ? "rgba(38,166,154,0.5)" : "rgba(239,83,80,0.5)",
      })));
      pane++;
    }
    if (toggles.rsi) {
      const rsi = chart.addSeries(LineSeries, {
        color: "#e6edf3", lineWidth: 1.5, priceLineVisible: false,
      }, pane);
      rsi.setData(lineData(data.dates, ind.rsi));
      rsi.createPriceLine({ price: 70, color: "#ef5350", lineStyle: 2, lineWidth: 1 });
      rsi.createPriceLine({ price: 30, color: "#26a69a", lineStyle: 2, lineWidth: 1 });
      pane++;
    }
    if (toggles.macd) {
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false }, pane);
      hist.setData(lineData(data.dates, ind.macd_hist).map((p) => ({
        ...p,
        color: p.value >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
      })));
      const ml = chart.addSeries(LineSeries, {
        color: "#42a5f5", lineWidth: 1.5, priceLineVisible: false,
      }, pane);
      ml.setData(lineData(data.dates, ind.macd));
      const sl = chart.addSeries(LineSeries, {
        color: "#f0b90b", lineWidth: 1.5, priceLineVisible: false,
      }, pane);
      sl.setData(lineData(data.dates, ind.macd_signal));
      pane++;
    }

    // Give the price pane the most height; lower panes share the rest.
    const panes = chart.panes();
    if (panes[0]) panes[0].setHeight(320);

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, toggles]);

  return <div ref={ref} className="candle-chart" />;
}
