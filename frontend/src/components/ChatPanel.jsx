import { useState, useRef, useEffect } from "react";
import { chat } from "../api.js";

// Suggestion chips per mode. A beginner and a scalper don't have the same
// questions, so offering the same three prompts to both wastes the affordance.
const SUGGESTIONS = {
  beginner: [
    "Explain this stock like I've never bought one before",
    "What are the biggest risks here, in plain English?",
    "Is this a fund or a single company? What am I actually buying?",
    "How much could I realistically lose?",
  ],
  standard: [
    "Which of these looks most overvalued and why?",
    "Compare the risk profiles of these holdings.",
    "What does the signal score breakdown actually tell me?",
    "Where does the forecast disagree with the trend line?",
  ],
  daytrader: [
    "Where are today's key levels and what invalidates them?",
    "How is my open position doing and where's my stop?",
    "Is this extended relative to ATR right now?",
    "What's the risk/reward from here to the next resistance?",
  ],
};

const PLACEHOLDER = {
  beginner: "Ask anything — no question is too basic…",
  standard: "Ask the analyst about this data…",
  daytrader: "Levels, sizing, open positions…",
};

export default function ChatPanel({ symbols, period, mode = "standard",
                                    positions = [], focused }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null); // {provider, model}
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Switching mode changes the analyst's whole register, so start a new thread
  // rather than leaving beginner-level answers above day-trader ones.
  useEffect(() => { setMessages([]); setMeta(null); }, [mode]);

  async function send(text) {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    const next = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      // Put the focused symbol first — the backend grounds the forecast and
      // intraday context on symbols[0].
      const ordered = focused
        ? [focused, ...symbols.filter((s) => s !== focused)]
        : symbols;
      const res = await chat(next, ordered, period, mode, positions);
      setMeta({ provider: res.provider, model: res.model });
      setMessages([...next, { role: "assistant", content: res.reply }]);
    } catch (e) {
      setMessages([...next, { role: "assistant", content: `⚠ ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  const chips = SUGGESTIONS[mode] || SUGGESTIONS.standard;
  const hasPositions = positions.length > 0;

  return (
    <section className="chat">
      <div className="chat-head">
        <h2>🤖 AI analyst</h2>
        <span className={`chat-mode ${mode}`}>{mode}</span>
      </div>
      {meta && <div className="chat-meta">{meta.provider} · {meta.model}</div>}

      <div className="chat-log">
        {messages.length === 0 && (
          <div className="chat-suggestions">
            <p className="muted">
              {mode === "beginner"
                ? "I'll explain every term as I go. Ask about "
                : "Ask about "}
              {symbols.join(", ") || "your symbols"}
              {hasPositions && mode === "daytrader"
                ? ` — I can see your ${positions.length} open position${positions.length === 1 ? "" : "s"}.`
                : hasPositions ? " — your positions are included." : ":"}
            </p>
            {chips.map((s) => (
              <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>{m.content}</div>
        ))}
        {busy && <div className="bubble assistant muted">Thinking…</div>}
        <div ref={endRef} />
      </div>

      <div className="chat-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={PLACEHOLDER[mode] || PLACEHOLDER.standard}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={busy}
        />
        <button onClick={() => send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </section>
  );
}
