import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { markTourSeen, targetElement, visibleSteps } from "../tour.js";

const PAD = 8;            // breathing room around the spotlight
const SCROLL_SETTLE_MS = 420;

// Guided tour with a spotlight: the page dims, the panel being described stays
// lit, and the view scrolls to it. Describing a panel in prose is far weaker
// than showing it with the words attached.
//
// The spotlight is a single full-screen overlay with a transparent hole punched
// through it, rather than four positioned strips — the hole can then have
// rounded corners and animate as it moves between steps without four elements
// fighting each other.
export default function Tour({ open, onClose, mode }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const [steps, setSteps] = useState([]);
  const cardRef = useRef(null);

  // Recompute which steps apply each time the tour opens: panels come and go
  // with the mode and with whether you have positions yet.
  useEffect(() => {
    if (!open) return;
    setSteps(visibleSteps(mode));
    setIndex(0);
  }, [open, mode]);

  const step = steps[index] || null;

  const measure = useCallback(() => {
    if (!step) return;
    const el = targetElement(step);
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    setRect({
      top: r.top - PAD, left: r.left - PAD,
      width: r.width + PAD * 2, height: r.height + PAD * 2,
    });
  }, [step]);

  // Scroll the target into view, then measure once it has settled. Measuring
  // before the smooth scroll finishes puts the spotlight where the element used
  // to be.
  useLayoutEffect(() => {
    if (!open || !step) return undefined;
    const el = targetElement(step);
    if (!el) { setRect(null); return undefined; }

    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    const t = setTimeout(measure, SCROLL_SETTLE_MS);
    return () => clearTimeout(t);
  }, [open, step, measure]);

  // Keep the hole aligned if the page moves underneath us.
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  const finish = useCallback(() => {
    markTourSeen();
    onClose();
  }, [onClose]);

  const next = useCallback(() => {
    setIndex((i) => (i >= steps.length - 1 ? (finish(), i) : i + 1));
  }, [steps.length, finish]);

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      if (e.key === "ArrowLeft") back();
    };
    document.addEventListener("keydown", onKey);
    // The page behind shouldn't scroll while a step is pinned to an element.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, next, back, finish]);

  useEffect(() => { cardRef.current?.focus(); }, [index, open]);

  if (!open || !step) return null;

  const last = index === steps.length - 1;
  // Put the card opposite the highlight so it never covers what it describes.
  const cardPos = (() => {
    if (!rect) return { centered: true };
    const below = rect.top + rect.height + 16;
    const roomBelow = window.innerHeight - below;
    return roomBelow > 220
      ? { top: below, centered: false }
      : { top: Math.max(16, rect.top - 236), centered: false };
  })();

  return (
    <div className="tour-root" role="dialog" aria-modal="true"
         aria-label={`Tour step ${index + 1} of ${steps.length}: ${step.title}`}>
      {/* One overlay with a hole, so the cut-out can animate between steps. */}
      <div
        className={`tour-overlay${rect ? "" : " no-hole"}`}
        onClick={finish}
        style={rect ? {
          clipPath: `polygon(
            0% 0%, 0% 100%, ${rect.left}px 100%, ${rect.left}px ${rect.top}px,
            ${rect.left + rect.width}px ${rect.top}px,
            ${rect.left + rect.width}px ${rect.top + rect.height}px,
            ${rect.left}px ${rect.top + rect.height}px, ${rect.left}px 100%,
            100% 100%, 100% 0%)`,
        } : undefined}
      />

      {rect && (
        <div className="tour-ring" style={{
          top: rect.top, left: rect.left,
          width: rect.width, height: rect.height,
        }} />
      )}

      <div
        ref={cardRef}
        tabIndex={-1}
        className={`tour-card${cardPos.centered ? " centered" : ""}`}
        style={cardPos.centered ? undefined : { top: cardPos.top }}
      >
        <div className="tour-progress">
          {steps.map((s, i) => (
            <span key={s.id} className={i === index ? "on" : i < index ? "done" : ""} />
          ))}
        </div>

        <h3>{step.title}</h3>
        <p>{step.body}</p>

        <div className="tour-actions">
          <button className="tour-skip" onClick={finish}>
            {last ? "Close" : "Skip tour"}
          </button>
          <span className="tour-count">{index + 1} / {steps.length}</span>
          <div className="tour-nav">
            {index > 0 && <button className="tour-btn" onClick={back}>Back</button>}
            <button className="tour-btn primary" onClick={next}>
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
