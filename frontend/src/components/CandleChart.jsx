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
    return new Date(time * 1000).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    });
  }
  const d = new Date(time + "T00:00:00Z");
  return d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

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

// Read a CSS variable from the document, falling back to a default.
function cssVar(name, fallback) {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export default function CandleChart({ data, toggles, settings, drawing, drawLevels, onAddLevel, zoomApi }) {
  const ref = useRef(null);
  const { type = "area", logScale = false, grid = true, crosshair = true } = settings || {};

  useEffect(() => {
    if (!ref.current || !data?.dates?.length) return;
    const intraday = data.dates[0].includes(" ");
    const t = (i) => toTime(data.dates[i]);
    const bg = cssVar("--bg", "#0d1117");
    const panel = cssVar("--panel", "#161b22");
    const border = cssVar("--border", "#30363d");
    const text = cssVar("--muted", "#8b949e");
    const gridColor = grid ? border : "rgba(0,0,0,0)";
    const accent = cssVar("--accent", "#58a6ff");

    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { color: bg }, textColor: text,
        panes: { separatorColor: border, separatorHoverColor: "#444" },
      },
      grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
      timeScale: {
        borderColor: border, timeVisible: intraday, secondsVisible: false,
        rightOffset: 2, minBarSpacing: 0.5, tickMarkFormatter: tickFmt,
      },
      rightPriceScale: { borderColor: border, mode: logScale ? 1 : 0 },
      crosshair: { mode: crosshair ? 1 : 2 },
      handleScroll: { vertTouchDrag: true },
      handleScale: { pinch: true, mouseWheel: true },
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
        upColor: hollow ? "rgba(0,0,0,0)" : "#26a69a", downColor: "#ef5350",
        borderVisible: true, borderUpColor: "#26a69a", borderDownColor: "#ef5350",
        wickUpColor: "#26a69a", wickDownColor: "#ef5350",
      }, 0);
      s.setData(data.dates.map((d, i) => ohlc(i)));
    } else if (type === "bars") {
      const s = chart.addSeries(BarSeries, { upColor: "#26a69a", downColor: "#ef5350" }, 0);
      s.setData(data.dates.map((d, i) => ohlc(i)));
    } else if (type === "heikin") {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: "#26a69a", downColor: "#ef5350", borderVisible: false,
        wickUpColor: "#26a69a", wickDownColor: "#ef5350",
      }, 0);
      s.setData(heikin(data).map((b) => ({ time: t(b.i), open: b.open, high: b.high, low: b.low, close: b.close })));
    } else {
      const color = up ? "#26a69a" : "#ef5350";
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
        color: text, lineWidth: 1.5, priceLineVisible: false,
      }, pane);
      rsi.setData(lineData(data.dates, ind.rsi));
      rsi.createPriceLine({ price: 70, color: "#ef5350", lineStyle: 2, lineWidth: 1 });
      rsi.createPriceLine({ price: 30, color: "#26a69a", lineStyle: 2, lineWidth: 1 });
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

    // --- Drawing: horizontal price levels ---
    if (drawLevels?.length) {
      const mainPane = chart.panes()[0];
      if (mainPane) {
        const series = mainPane.getSeries().find(() => true);
        drawLevels.forEach((lvl) => {
          const series = chart.addSeries(LineSeries, {
            color: lvl.color || "#f0b90b", lineWidth: 1,
            priceLineVisible: false, lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, 0);
          const dates = data.dates;
          series.setData([
            { time: toTime(dates[0]), value: lvl.price },
            { time: toTime(dates[dates.length - 1]), value: lvl.price },
          ]);
        });
      }
    }

    // --- Drawing mode: click to add level ---
    if (drawing && onAddLevel) {
      chart.subscribeClick((param) => {
        if (!param.point) return;
        const price = chart.priceScale("right").coordinateToPrice(param.point.y);
        if (price != null) onAddLevel(parseFloat(price.toFixed(2)));
      });
    }

    // Zoom API — proportional zoom relative to chart center
    if (zoomApi) {
      zoomApi.current = {
        zoomIn: () => { chart.timeScale().zoom(1.3); },
        zoomOut: () => { chart.timeScale().zoom(0.7); },
        resetZoom: () => { chart.timeScale().fitContent(); },
      };
    }

    const panes = chart.panes();
    if (panes[0]) panes[0].setHeight(320);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, toggles, type, logScale, grid, crosshair, drawing, drawLevels, onAddLevel]);

  return (
    <div ref={ref} className={`candle-chart ${drawing ? "draw-mode" : ""}`}
         style={{ cursor: drawing ? "crosshair" : "" }} />
  );
}
