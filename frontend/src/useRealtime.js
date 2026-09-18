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

// Finnhub's stream needs an EXCHANGE-PREFIXED symbol for crypto: plain
// "BTC-USD" is subscribed successfully and then never ticks, because that is a
// Yahoo ticker, not a Finnhub one. Coinbase is used rather than Binance so the
// pair is genuinely USD — a USDT pair would quote a slightly different number
// from the rest of the app and nothing would explain the discrepancy.
//
// Trades also come back keyed by the FINNHUB symbol, so the mapping has to be
// reversible or every tick lands under a key nothing is looking at. 24/7
// markets are exactly where a live price matters most, since there is no close
// to fall back on.
const CRYPTO_RE = /^([A-Z0-9]{2,10})-(USD|USDT|EUR|GBP)$/;

export function toStreamSymbol(symbol) {
  const m = CRYPTO_RE.exec(String(symbol).toUpperCase());
  return m ? `COINBASE:${m[1]}-${m[2]}` : symbol;
}

export function fromStreamSymbol(streamSymbol) {
  const s = String(streamSymbol || "");
  const colon = s.indexOf(":");
  return colon === -1 ? s : s.slice(colon + 1);
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
          ws.send(JSON.stringify({ type: "subscribe", symbol: toStreamSymbol(s) })));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "trade" && msg.data) {
          // Map back, so a COINBASE:BTC-USD tick lands under BTC-USD where the
          // rest of the app is looking for it.
          for (const t of msg.data) {
            pending[fromStreamSymbol(t.s)] = { price: t.p, ts: t.t };
          }
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
            ws.send(JSON.stringify({ type: "unsubscribe", symbol: toStreamSymbol(s) })));
        }
        ws && ws.close();
      } catch { /* noop */ }
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { prices, connected };
}
