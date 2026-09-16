import { useState } from "react";
import { GLOSSARY } from "../modes.js";

// A dotted-underlined term that reveals a plain-English definition.
//
// Only renders the affordance in beginner mode — in standard/day-trader mode it
// passes the children straight through, so the same panel markup serves all
// three audiences without a parallel set of components.
export default function Explain({ term, children, enabled = true }) {
  const [open, setOpen] = useState(false);
  const text = GLOSSARY[term];

  if (!enabled || !text) return <>{children ?? term}</>;

  return (
    <span
      className="explain"
      tabIndex={0}
      role="button"
      aria-expanded={open}
      aria-label={`What is ${term}?`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); }
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <span className="explain-term">{children ?? term}</span>
      <span className="explain-mark" aria-hidden="true">?</span>
      {open && (
        <span className="explain-pop" role="tooltip">
          <strong>{term}</strong>
          {text}
        </span>
      )}
    </span>
  );
}
