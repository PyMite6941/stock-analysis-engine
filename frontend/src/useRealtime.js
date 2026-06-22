import { useState, useEffect, useRef } from "react";

// Cache the token lookup so every hook instance shares one fetch.
let _tokenPromise;
function getToken() {
  if (!_tokenPromise) {
    _tokenPromise = fetch("/api/realtime-token")
      .then((r) => r.json())
      .then((d) => d.token || null)
      .catch(() => null);
  }
  return _tokenPromise;
}

/**
 * Free client-side real-time prices via Finnhub's WebSocket.
 *   - browser connects directly to wss://ws.finnhub.io (no backend in the path)
 *   - trades are batched and flushed ~2x/sec to avoid re-render storms
 *   - auto-reconnects; unsubscribes + closes on cleanup
 *   - if no token is configured, returns connected:false (UI falls back to polling)
 *
 * Returns { prices: { SYMBOL: { price, ts } }, connected }.
 * Note: Finnhub only streams trades during market hours — quiet outside RTH.
 */
export function useRealtime(symbols) {
  const [prices, setPrices] = useState({});
  const [connected, setConnected] = useState(false);
  const key = symbols.join(",");
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;

  useEffect(() => {
    if (!symbols.length) return;
    let cancelled = false;
    let ws;
    let reconnectTimer;
    let pending = {};

    async function connect() {
      const token = await getToken();
      if (!token || cancelled) return;
      ws = new WebSocket(`wss://ws.finnhub.io?token=${token}`);
      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        symbolsRef.current.forEach((s) =>
          ws.send(JSON.stringify({ type: "subscribe", symbol: s })));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "trade" && msg.data) {
          for (const t of msg.data) pending[t.s] = { price: t.p, ts: t.t };
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    }
    connect();

    const flush = setInterval(() => {
      if (Object.keys(pending).length) {
        setPrices((prev) => ({ ...prev, ...pending }));
        pending = {};
      }
    }, 500);

    return () => {
      cancelled = true;
      clearInterval(flush);
      clearTimeout(reconnectTimer);
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          symbolsRef.current.forEach((s) =>
            ws.send(JSON.stringify({ type: "unsubscribe", symbol: s })));
        }
        ws && ws.close();
      } catch { /* noop */ }
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { prices, connected };
}
