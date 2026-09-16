import { MODES, MODE_ORDER } from "../modes.js";

// Three-way segmented control in the header. Mode is the single biggest lever
// on what the page shows, so it sits at the top level rather than in settings.
export default function ModeSwitch({ mode, onChange, compact = false }) {
  return (
    <div className={`mode-switch${compact ? " compact" : ""}`} role="tablist"
         aria-label="Experience mode">
      {MODE_ORDER.map((id) => {
        const m = MODES[id];
        const active = mode === id;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={active}
            className={`mode-btn${active ? " active" : ""}`}
            onClick={() => onChange(id)}
            title={m.tagline}
          >
            <span className="mode-icon">{m.icon}</span>
            <span className="mode-label">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
