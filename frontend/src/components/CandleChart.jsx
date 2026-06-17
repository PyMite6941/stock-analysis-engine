import { useEffect, useRef } from "react";
import {
  createChart, CandlestickSeries, BarSeries, AreaSeries, LineSeries, HistogramSeries,
} from "lightweight-charts";

function toTime(d) {
  return d.includes(" ")
    ? Math.floor(Date.parse(d.replace(" ", "T") + "Z") / 1000)
    : d;
}

function lineData(dates, arr) {
  if (!arr) return [];
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    if (arr[i] != null) out.push({ time: toTime(dates[i]), value: arr[i] });
  }
  return out;
}

function tickFmt(time) {
  if (typeof time === "number") {
    return new Date(time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const d = new Date(time + "T00:00:00");
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Heikin-Ashi OHLC derived from the raw candles.
function heikin(data) {
  const out = [];
  let pOpen, pClose;
  for (let i = 0; i < data.close.length; i++) {
    const o = data.open[i], h = data.high[i], l = data.low[i], c = data.close[i];
    const haClose = (o + h + l + c) / 4;
    const haOpen = i === 0 ? (o + c) / 2 : (pOpen + pClose) / 2;
    out.push({
      i, open: haOpen, close: haClose,
      high: Math.max(h, haOpen, haClose), low: Math.min(l, haOpen, haClose),
    });
    pOpen = haOpen; pClose = haClose;
  }
  return out;
}

const GREEN = "#26a69a", RED = "#ef5350";

export default function CandleChart({ data, toggles, settings }) {
  const ref = useRef(null);
  const { type = "area", logScale = false, grid = true, crosshair = true } = settings || {};

  useEffect(() => {
    if (!ref.current || !data?.dates?.length) return;
    const intraday = data.dates[0].includes(" ");
    const t = (i) => toTime(data.dates[i]);
    const gridColor = grid ? "#161b22" : "rgba(0,0,0,0)";

    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { color: "#0d1117" }, textColor: "#8b949e",
        panes: { separatorColor: "#30363d", separatorHoverColor: "#444" },
      },
      grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
      timeScale: {
        borderColor: "#30363d", timeVisible: intraday, secondsVisible: false,
        rightOffset: 2, minBarSpacing: 0.5, tickMarkFormatter: tickFmt,
      },
      rightPriceScale: { borderColor: "#30363d", mode: logScale ? 1 : 0 },
      crosshair: { mode: crosshair ? 1 : 2 },
    });

    const ohlc = (i) => ({
      time: t(i), open: data.open[i], high: data.high[i],
      low: data.low[i], close: data.close[i],
    });
    const up = data.close.at(-1) >= data.close[0];

    // --- Pane 0: main price series ---
    if (type === "candles" || type === "hollow") {
      const hollow = type === "hollow";
      const s = chart.addSeries(CandlestickSeries, {
        upColor: hollow ? "rgba(0,0,0,0)" : GREEN, downColor: RED,
        borderVisible: true, borderUpColor: GREEN, borderDownColor: RED,
        wickUpColor: GREEN, wickDownColor: RED,
      }, 0);
      s.setData(data.dates.map((d, i) => ohlc(i)));
    } else if (type === "bars") {
      const s = chart.addSeries(BarSeries, { upColor: GREEN, downColor: RED }, 0);
      s.setData(data.dates.map((d, i) => ohlc(i)));
    } else if (type === "heikin") {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: GREEN, downColor: RED, borderVisible: false,
        wickUpColor: GREEN, wickDownColor: RED,
      }, 0);
      s.setData(heikin(data).map((b) => ({ time: t(b.i), open: b.open, high: b.high, low: b.low, close: b.close })));
    } else {
      const color = up ? GREEN : RED;
      const s = chart.addSeries(AreaSeries, {
        lineColor: color, lineWidth: 2,
        topColor: up ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)",
        bottomColor: "rgba(13,17,23,0)", priceLineVisible: false,
      }, 0);
      s.setData(data.dates.map((d, i) => ({ time: t(i), value: data.close[i] })));
    }

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
      rsi.createPriceLine({ price: 70, color: RED, lineStyle: 2, lineWidth: 1 });
      rsi.createPriceLine({ price: 30, color: GREEN, lineStyle: 2, lineWidth: 1 });
      pane++;
    }
    if (toggles.macd) {
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false }, pane);
      hist.setData(lineData(data.dates, ind.macd_hist).map((p) => ({
        ...p, color: p.value >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
      })));
      const ml = chart.addSeries(LineSeries, { color: "#42a5f5", lineWidth: 1.5, priceLineVisible: false }, pane);
      ml.setData(lineData(data.dates, ind.macd));
      const sl = chart.addSeries(LineSeries, { color: "#f0b90b", lineWidth: 1.5, priceLineVisible: false }, pane);
      sl.setData(lineData(data.dates, ind.macd_signal));
      pane++;
    }

    const panes = chart.panes();
    if (panes[0]) panes[0].setHeight(320);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, toggles, type, logScale, grid, crosshair]);

  return <div ref={ref} className="candle-chart" />;
}
