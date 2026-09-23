import { useEffect, useState } from "react";
import { portfolioEvents } from "../api.js";
import { num } from "../format.js";

// What is scheduled ahead for what you hold.
//
// The forecast cone treats price as a random walk. That is a fair model of a
// quiet week and a terrible one for the night a company reports earnings, which
// is the most common reason a position gaps overnight. The cone cannot know a
// date is coming; this panel is how you find out.
//
// It says when, never what will happen. An earnings date is context for a
// decision, not a signal — anyone claiming to know the direction in advance is
// guessing.

const ICON = { earnings: "📣", ex_dividend: "💵" };

export default function EventsPanel({ positions, symbols = [],
                                      beginner = false, onSelect }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // Only the symbol set matters, not share counts — re-fetching because a
  // quantity changed would be pure waste.
  const key = [...new Set([...(positions || []).map((p) => p.symbol),
                           ...symbols])].sort().join(",");

  useEffect(() => {
    let cancelled = false;
    if (!key) { setData(null); return undefined; }
    portfolioEvents(positions, symbols, 90)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [key]);      // eslint-disable-line react-hooks/exhaustive-deps

  if (!key) return null;
  if (error) {
    return (
      <section className="panel">
        <h2>📅 Coming up</h2>
        <p className="error-inline">⚠ {error}</p>
      </section>
    );
  }
  if (!data) return null;

  const events = data.events || [];

  return (
    <section className="panel events-panel">
      <div className="panel-head">
        <h2>📅 Coming up</h2>
        {data.n_imminent > 0 && (
          <span className="tag imminent">
            {data.n_imminent} within {3} days
          </span>
        )}
      </div>

      {beginner && (
        <p className="beginner-note">
          Two dates move a share price on schedule.{" "}
          <strong>Earnings</strong> is when a company reports how it did — the
          price often jumps hard in either direction that evening.{" "}
          <strong>Ex-dividend</strong> is the cutoff for receiving the next
          dividend; the price usually drops by about the dividend that morning,
          which looks like a loss but isn't.
        </p>
      )}

      {!events.length && (
        <p className="muted">
          Nothing scheduled in the next 90 days for what you hold.
        </p>
      )}

      {events.length > 0 && (
        <ul className="event-list">
          {events.map((e) => (
            <li key={`${e.symbol}-${e.kind}-${e.date}`}
                className={`event ${e.urgency}`}>
              <span className="ev-icon" aria-hidden="true">{ICON[e.kind]}</span>
              <button className="link-sym" onClick={() => onSelect?.(e.symbol)}>
                {e.symbol}
              </button>
              <span className="ev-label">{e.label}</span>
              {e.kind === "ex_dividend" && e.amount != null && (
                <span className="muted">${num(e.amount)}/share per year</span>
              )}
              <span className="ev-date muted">{e.date}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="fine-print">
        Dates come from the exchange's published calendar and can move; ones
        marked <em>(est.)</em> were inferred from past reporting cadence and can
        shift by a week. A date is context, not a prediction — this panel has no
        opinion on which way anything goes.
      </p>
    </section>
  );
}
