import { useEffect, useState } from "react";
import { priceFreshness } from "../market.js";

// The status line under the search bar: where these prices came from, how old
// they are, and whether the market is even open.
//
// It re-renders on its own once a second. That sounds wasteful and is the
// point: an age that only updates when something else happens to re-render
// will sit at "3s ago" for a minute, which is worse than showing nothing
// because it looks precise while being wrong.

export default function PriceClock({ lastTick, lastPoll, streaming = false,
                                     continuous = false }) {
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const f = priceFreshness({ lastTick, lastPoll, streaming, continuous });

  return (
    <p className={`price-clock ${f.stale ? "stale" : f.state}`} role="status">
      <span className={`clock-dot ${f.stale ? "stale"
                                            : f.live ? "live" : "shut"}`}
            aria-hidden="true">●</span>
      <span>{f.text}</span>
      {!f.continuous && f.live && !f.stale && f.state !== "open" && (
        <span className="muted"> · {f.label}</span>
      )}
      {f.stale && (
        <span className="muted">
          {" "}· check your connection, or reload
        </span>
      )}
    </p>
  );
}
