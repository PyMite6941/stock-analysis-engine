import { useEffect, useRef, useState } from "react";
import { searchSymbols } from "../api.js";

// Search box that accepts a company name as well as a ticker.
//
// Not knowing the ticker is a dead end for a beginner: the ticker is precisely
// what they were trying to find out, so "Stock/ETF not found: NVIDIA" tells
// them nothing they can act on. Typing a name now offers the matching symbols
// with their asset class, so the answer is one tap away.
//
// Lookup is debounced and aborted on each keystroke — the endpoint is fast, but
// firing one request per character wastes it and the replies can arrive out of
// order, briefly showing results for a prefix the user has already moved past.
export default function SymbolSearch({
  value, onChange, onSubmit, placeholder, disabled, autoFocus, className,
}) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);
  const abortRef = useRef(null);
  const skipRef = useRef(false);     // set after picking, so we don't re-search

  useEffect(() => {
    if (skipRef.current) { skipRef.current = false; return undefined; }
    const q = (value || "").trim();
    // A comma means they're building a watchlist by ticker; don't suggest.
    if (q.length < 2 || q.includes(",")) {
      setResults([]);
      setOpen(false);
      return undefined;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort?.();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const res = await searchSymbols(q, 7, controller.signal);
        if (controller.signal.aborted) return;
        setResults(res.results || []);
        setOpen((res.results || []).length > 0);
        setActive(-1);
      } catch {
        /* a failed lookup shouldn't block typing a ticker directly */
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    const away = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  function pick(r) {
    skipRef.current = true;
    setOpen(false);
    setResults([]);
    onChange(r.symbol);
    onSubmit(r.symbol);
  }

  function onKeyDown(e) {
    if (!open || !results.length) {
      if (e.key === "Enter") onSubmit(value);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter with nothing highlighted submits what was typed — a ticker the
      // user knows shouldn't need them to dismiss a dropdown first.
      if (active >= 0) pick(results[active]);
      else { setOpen(false); onSubmit(value); }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className={`symbol-search ${className || ""}`} ref={wrapRef}>
      <input
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => results.length && setOpen(true)}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {loading && <span className="search-spinner" aria-hidden="true">…</span>}

      {open && results.length > 0 && (
        <ul className="symbol-results" role="listbox">
          {results.map((r, i) => (
            <li key={r.symbol}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : ""}
                onMouseEnter={() => setActive(i)}
                // mousedown, not click: the input's blur would close the list
                // before a click ever lands.
                onMouseDown={(e) => { e.preventDefault(); pick(r); }}>
              <span className="sr-symbol">{r.symbol}</span>
              <span className="sr-name">{r.name}</span>
              <span className={`sr-class ${r.asset_class}`}>{r.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
