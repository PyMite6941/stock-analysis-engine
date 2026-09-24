import { useState } from "react";
import { money, num, pct } from "../format.js";
import { START_CASH, buy, loadAccount, newAccount, saveAccount, sell, valueAccount } from "../paper.js";
import Explain from "./Explain.jsx";

// Practise with pretend money at real prices. See paper.js for the rules.
export default function PaperTradePanel({ symbol, price, livePrices = {}, beginner = false,
                                          onSelect }) {
  const [account, setAccountState] = useState(loadAccount);
  const [shares, setShares] = useState("1");
  const [msg, setMsg] = useState(null);

  const setAccount = (a) => setAccountState(saveAccount(a));

  const prices = Object.fromEntries(
    Object.entries(livePrices).map(([s, q]) => [s, q?.price]).filter(([, p]) => p != null));
  if (symbol && price) prices[symbol] = price;
  const v = valueAccount(account, prices);
  const held = account.holdings[symbol];

  function trade(side) {
    try {
      if (!price) throw new Error("No live price yet — try again in a moment.");
      if (side === "buy") {
        setAccount(buy(account, symbol, shares, price));
        setMsg({ ok: true, text: `Bought ${shares} ${symbol} at ${money(price)} (pretend).` });
      } else {
        const r = sell(account, symbol, shares, price);
        setAccount(r.account);
        setMsg({ ok: r.profit >= 0,
                 text: `Sold ${shares} ${symbol} for a ${r.profit >= 0 ? "profit" : "loss"} of ${money(Math.abs(r.profit))}.` });
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  }

  function reset() {
    if (window.confirm(`Start over with ${money(START_CASH)} of pretend cash?`)) {
      setAccount(newAccount());
      setMsg(null);
    }
  }

  const holdings = Object.entries(account.holdings);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>🎮 <Explain term="Paper trading" enabled={beginner}>Paper trading</Explain></h2>
        <button className="ghost tiny-btn" onClick={reset}>Reset</button>
      </div>
      <p className="muted small">
        Pretend money, real prices. Nothing here is real or leaves this browser.
      </p>

      <div className="fund-stats">
        <div className="fund-stat"><span className="k">Account value</span>
          <span className="v">{money(v.total)}</span>
          <span className={`sub ${v.gain >= 0 ? "up" : "down"}`}>
            {v.gain >= 0 ? "+" : "−"}{money(Math.abs(v.gain))} ({pct(v.gainPct)}) since start</span></div>
        <div className="fund-stat"><span className="k">Cash</span>
          <span className="v">{money(v.cash)}</span></div>
        <div className="fund-stat"><span className="k">Invested</span>
          <span className="v">{money(v.invested)}</span></div>
      </div>

      {symbol && (
        <div className="pos-fields" style={{ marginTop: 14 }}>
          <label>Shares of {symbol}
            <input type="number" min="0" step="any" inputMode="decimal"
                   value={shares} onChange={(e) => setShares(e.target.value)} />
          </label>
          <div className="pos-submit">
            <button className="ghost" onClick={() => trade("buy")}>
              Buy{price ? ` @ ${money(price)}` : ""}</button>
            <button className="ghost" onClick={() => trade("sell")} disabled={!held}>Sell</button>
          </div>
        </div>
      )}
      {price && Number(shares) > 0 && (
        <p className="pos-preview">That's <strong>{money(Number(shares) * price)}</strong>
          {held ? <> · you own {num(held.shares, 4)} at {money(held.cost / held.shares)} avg</> : null}</p>
      )}
      {msg && <p className={`pos-preview ${msg.ok ? "up" : "down"}`}>{msg.text}</p>}

      {holdings.length > 0 && (
        <table className="paper-table">
          <thead><tr><th>Stock</th><th>Shares</th><th>Avg cost</th><th>Gain</th></tr></thead>
          <tbody>
            {holdings.map(([s, h]) => {
              const now = prices[s];
              const gain = now != null ? now * h.shares - h.cost : null;
              return (
                <tr key={s} onClick={() => onSelect?.(s)} style={{ cursor: onSelect ? "pointer" : "default" }}>
                  <td><strong>{s}</strong></td>
                  <td>{num(h.shares, 4)}</td>
                  <td>{money(h.cost / h.shares)}</td>
                  <td className={gain == null ? "muted" : gain >= 0 ? "up" : "down"}>
                    {gain == null ? "—" : `${gain >= 0 ? "+" : "−"}${money(Math.abs(gain))}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
