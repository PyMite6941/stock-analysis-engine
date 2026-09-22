import { useState, useEffect, useRef } from "react";
import { apiUrl } from "./runtime.js";

// Cache the token lookup so every hook instance shares one fetch.
let _tokenPromise;
function getToken() {
  if (!_tokenPromise) {
    _tokenPromise = fetch(apiUrl("/api/realtime-token"))
      .then((r) => r.json())
      .then((d) => d.token || null)
      .catch(() => null);
  }
  return _tokenPromise;
}

// Finnhub's stream needs an EXCHANGE-PREFIXED symbol for crypto: plain
// "BTC-USD" is subscribed successfully and then never ticks, because that is a
// Yahoo ticker, not a Finnhub one. Trades also come back keyed by the FINNHUB
// symbol, so the mapping has to be reversible or every tick lands under a key
// nothing is looking at.
//
// We subscribe to BOTH exchanges per coin, because they are not
// interchangeable and neither is guaranteed:
//   COINBASE:BTC-USD   a genuine USD pair, so the number matches the rest of
//                      the app — but this format is not in Finnhub's published
//                      examples and may not be on every plan.
//   BINANCE:BTCUSDT    the format Finnhub actually documents, so it is the one
//                      most likely to work — but it quotes in Tether, which
//                      tracks USD to roughly a tenth of a percent rather than
//                      exactly.
//
// Coinbase ticks win when both arrive; Binance is only used for a coin that
// Coinbase has not delivered. That way the displayed price matches the app's
// USD basis whenever possible, and still updates when it cannot. 24/7 markets
// are where a live price matters most, since there is no close to fall back on.
const CRYPTO_RE = /^([A-Z0-9]{2,10})-(USD|USDT|EUR|GBP)$/;

/** Every stream symbol worth subscribing to for one app ticker. */
export function streamSymbolsFor(symbol) {
  const sym = String(symbol).toUpperCase();
  const m = CRYPTO_RE.exec(sym);
  if (!m) return [sym];
  const [, base, quote] = m;
  const out = [`COINBASE:${base}-${quote}`];
  if (quote === "USD") out.push(`BINANCE:${base}USDT`);
  return out;
}

/** Preferred single stream symbol — used by tests and for logging. */
export function toStreamSymbol(symbol) {
  return streamSymbolsFor(symbol)[0];
}

/** Map a Finnhub symbol back to the ticker the rest of the app uses. */
export function fromStreamSymbol(streamSymbol) {
  const s = String(streamSymbol || "");
  const colon = s.indexOf(":");
  if (colon === -1) return s;
  const exchange = s.slice(0, colon);
  const rest = s.slice(colon + 1);
  // BINANCE:BTCUSDT -> BTC-USD, so a Tether tick updates the USD row rather
  // than creating a phantom "BTCUSDT" position nothing references.
  if (exchange === "BINANCE" && rest.endsWith("USDT")) {
    return `${rest.slice(0, -4)}-USD`;
  }
  return rest;
}

/** True when a tick should be ignored in favour of one already seen. */
export function preferTick(existing, incoming) {
  if (!existing) return true;
  // A genuine USD pair beats a Tether proxy for the same coin.
  if (existing.source === "COINBASE" && incoming.source !== "COINBASE") return false;
  return true;
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
          streamSymbolsFor(s).forEach((stream) =>
            ws.send(JSON.stringify({ type: "subscribe", symbol: stream }))));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "trade" && msg.data) {
          // Map back, so a COINBASE:BTC-USD tick lands under BTC-USD where the
          // rest of the app is looking for it, and prefer the USD pair when
          // both exchanges report the same coin.
          for (const t of msg.data) {
            const key = fromStreamSymbol(t.s);
            const source = String(t.s).split(":")[0];
            const tick = { price: t.p, ts: t.t, source };
            if (preferTick(pending[key], tick)) pending[key] = tick;
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
            streamSymbolsFor(s).forEach((stream) =>
              ws.send(JSON.stringify({ type: "unsubscribe", symbol: stream }))));
        }
        ws && ws.close();
      } catch { /* noop */ }
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { prices, connected };
}
