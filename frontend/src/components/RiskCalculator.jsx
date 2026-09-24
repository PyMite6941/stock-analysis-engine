import { useEffect, useState } from "react";
import { money, num } from "../format.js";
import { breakEvenWinRate, sizePosition } from "../tradeMath.js";
import Explain from "./Explain.jsx";

// "How many shares should I buy?" — answered from how much you're willing to
// lose, not from how confident you feel. Pure arithmetic (tradeMath.js), so it
// works with no server and no API key.
export default function RiskCalculator({ symbol, livePrice, beginner = false }) {
  const [account, setAccount] = useState(() => localStorage.getItem("sae:account") || "");
  const [riskPct, setRiskPct] = useState(() => localStorage.getItem("sae:risk") || "1");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");

  useEffect(() => { try { localStorage.setItem("sae:account", account); } catch { /* */ } }, [account]);
  useEffect(() => { try { localStorage.setItem("sae:risk", riskPct); } catch { /* */ } }, [riskPct]);
  // Start the entry at the live price so there's one less box to fill.
  useEffect(() => { if (!entry && livePrice) setEntry(String(livePrice)); }, [livePrice]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setEntry(livePrice ? String(livePrice) : ""); setStop(""); setTarget(""); }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = sizePosition({ account, riskPct, entry, stop, target: target || null });
  const be = p?.rewardRisk ? breakEvenWinRate(p.rewardRisk) : null;

  const field = (label, value, set, placeholder) => (
    <label>
      {label}
      <input type="number" inputMode="decimal" min="0" step="any" placeholder={placeholder}
             value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );

  return (
    <section className="panel">
      <h2>🧮 Position size &amp; risk{symbol ? ` — ${symbol}` : ""}</h2>
      <p className="muted small">
        Decide what you can afford to lose <em>first</em>. The calculator turns that
        into a share count, so hitting your{" "}
        <Explain term="Stop-loss" enabled={beginner}>stop</Explain> is a small, planned loss.
      </p>
      <div className="pos-fields">
        {field("Account $", account, setAccount)}
        {field("Risk %", riskPct, setRiskPct, "1 is common")}
        {field("Entry $", entry, setEntry)}
        {field("Stop $", stop, setStop)}
        {field("Target $", target, setTarget, "optional")}
      </div>

      {!p ? (
        <p className="pos-preview">Fill in account, entry and stop to see a size.</p>
      ) : p.shares === 0 ? (
        <p className="pos-preview down">
          Your stop is {money(p.riskPerShare)} away, but your risk budget is only{" "}
          {money(p.riskBudget)} — even 1 share would lose more than you planned. Move the
          stop closer, or skip this trade.
        </p>
      ) : (
        <div className="fund-stats" style={{ marginTop: 14 }}>
          <div className="fund-stat"><span className="k">Buy</span>
            <span className="v">{num(p.shares, 0)} sh</span>
            <span className="sub">{p.side === "long" ? "long (buying)" : "short (selling first)"}</span></div>
          <div className="fund-stat"><span className="k">Position size</span>
            <span className="v">{money(p.positionValue)}</span>
            <span className="sub">{num(p.pctOfAccount, 1)}% of account</span></div>
          <div className="fund-stat"><span className="k">If stopped out</span>
            <span className="v down">−{money(p.maxLoss)}</span>
            <span className="sub">{money(p.riskPerShare)} per share</span></div>
          {p.rewardRisk !== null && (
            <div className="fund-stat"><span className="k">Reward : risk</span>
              <span className={`v ${p.targetOnWrongSide ? "down" : p.rewardRisk >= 2 ? "up" : "warn"}`}>
                {p.targetOnWrongSide ? "—" : `${num(p.rewardRisk, 2)} : 1`}</span>
              <span className="sub">{p.targetOnWrongSide
                ? "Target is on the wrong side of entry"
                : `+${money(p.reward)} at target · need to win ${num(be, 0)}% to break even`}</span></div>
          )}
        </div>
      )}
      {p?.cappedByCash && (
        <p className="pos-preview">Your stop is so tight that the risk budget would buy more
          than the account can pay for, so this is capped at what you can afford.</p>
      )}
    </section>
  );
}
