import { useState, useRef, useEffect } from "react";
import { chat } from "../api.js";

const SUGGESTIONS = [
  "Which of these looks most overvalued and why?",
  "Compare the risk profiles of these holdings.",
  "What does the trend signal tell me about each?",
];

export default function ChatPanel({ symbols, period }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null); // {provider, model}
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text) {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    const next = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await chat(next, symbols, period);
      setMeta({ provider: res.provider, model: res.model });
      setMessages([...next, { role: "assistant", content: res.reply }]);
    } catch (e) {
      setMessages([...next, { role: "assistant", content: `⚠ ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="chat">
      <div className="chat-head">
        <h2>🤖 AI analyst</h2>
        {meta && <span className="chat-meta">{meta.provider} · {meta.model}</span>}
      </div>

      <div className="chat-log">
        {messages.length === 0 && (
          <div className="chat-suggestions">
            <p className="muted">Ask about {symbols.join(", ")}:</p>
            {SUGGESTIONS.map((s) => (
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
          placeholder="Ask the analyst about this data…"
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={busy}
        />
        <button onClick={() => send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </section>
  );
}
