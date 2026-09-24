import { useEffect, useState } from "react";
import { nextSessionChange } from "../market.js";

// "● Market open · Closes in 45m" — one glance tells a day trader how long is
// left and tells a beginner that the stock market keeps hours at all.
export default function SessionChip() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  const s = nextSessionChange(now);
  return (
    <p className={`session-chip ${s.state}`} role="status"
       title="US stock market hours (New York time). Holidays aren't included.">
      <span className="clock-dot" aria-hidden="true">●</span>
      {s.label} · {s.text}
    </p>
  );
}
