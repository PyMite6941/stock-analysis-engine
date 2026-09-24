import { useEffect, useState } from "react";
import { quotes as fetchQuotes } from "../api.js";
import { backendAvailable } from "../runtime.js";
import { seedNames } from "../direct.js";
import { rankMovers, UNIVERSE_NAMES, UNIVERSE_SYMBOLS } from "../movers.js";
import Explain from "./Explain.jsx";

// Yahoo-style "Top gainers / Top losers" over the 30 biggest US names.
//
// With a backend this loads straight away (one request). Without one, each
// stock is a separate call against the visitor's free-tier key, so it waits
// for a click instead of silently spending half their minute's allowance.
export default function MarketMovers({ onOpen, beginner = false }) {
  const [tab, setTab] = useState("gainers");
  const [state, setState] = useState({ loading: false, error: null, movers: null });
  const [asked, setAsked] = useState(backendAvailable());

  useEffect(() => {
    if (!asked) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    seedNames(UNIVERSE_NAMES);
    fetchQuotes(UNIVERSE_SYMBOLS)
      .then((res) => { if (!cancelled) setState({ loading: false, error: null, movers: rankMovers(res.quotes) }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: e.message, movers: null }); });
    return () => { cancelled = true; };
  }, [asked]);

  const list = state.movers?.[tab] || [];

  return (
    <section className="standings movers">
      <div className="standings-head">
        <h2>🔥 <Explain term="Market movers" enabled={beginner}>Today's movers</Explain></h2>
        <div className="seg small-seg" role="tablist">
          {[["gainers", "▲ Gainers"], ["losers", "▼ Losers"]].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id}
                    className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      </div>

      {!asked && (
        <button className="ghost" onClick={() => setAsked(true)}>
          Load today's movers <span className="muted">(uses ~30 of your free API calls)</span>
        </button>
      )}
      {state.loading && <div className="skeleton" style={{ height: 150, borderRadius: 10 }} />}
      {state.error && <p className="error-inline">⚠ {state.error}</p>}
      {state.movers && (
        list.length ? (
          <ol className="movers-list">
            {list.map((q) => (
              <li key={q.symbol}>
                <button onClick={() => onOpen(q.symbol)}>
                  <span className="mv-sym">{q.symbol}</span>
                  <span className="mv-name">{q.name}</span>
                  <span className="mv-price">{q.price?.toFixed(2)}</span>
                  <span className={`mv-chg ${q.change_pct >= 0 ? "pos" : "neg"}`}>
                    {q.change_pct >= 0 ? "+" : ""}{q.change_pct.toFixed(2)}%</span>
                </button>
              </li>
            ))}
          </ol>
        ) : <p className="muted">Nothing is {tab === "gainers" ? "up" : "down"} today among the 30 largest US stocks.</p>
      )}
      <p className="muted tiny">Ranked among the 30 largest US companies, not the whole market.</p>
    </section>
  );
}
