import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { markTourSeen, stepsForMode, targetElement, waitForTarget } from "../tour.js";

const PAD = 8;            // breathing room around the spotlight

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
  const [resolving, setResolving] = useState(false);
  const cardRef = useRef(null);
  // Which way the user is moving, so a step with no target on this page is
  // skipped in that direction rather than bouncing them back.
  const dirRef = useRef(1);

  useEffect(() => {
    if (!open) return;
    setSteps(stepsForMode(mode));
    setIndex(0);
    dirRef.current = 1;
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

  // Find the target (waiting briefly for panels that load after the page),
  // JUMP to it, then measure. An instant jump rather than a smooth scroll: on a
  // phone the lower panels are several screens down, and a smooth scroll was
  // still travelling when the spotlight measured, leaving the ring drawn around
  // empty space. The spotlight itself still animates, so it doesn't feel abrupt.
  useLayoutEffect(() => {
    if (!open || !step) return undefined;
    let cancelled = false;

    if (!step.target) { setRect(null); return undefined; }

    setResolving(true);
    waitForTarget(step).then((el) => {
      if (cancelled) return;
      setResolving(false);
      if (!el) {
        // Genuinely not on this page (e.g. no positions yet): move on in the
        // direction of travel instead of showing a card that points at nothing.
        setIndex((i) => {
          const nextI = i + dirRef.current;
          if (nextI < 0 || nextI >= steps.length) return i;
          return nextI;
        });
        return;
      }
      el.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
      // Two frames: one for the scroll to apply, one for layout to settle.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) measure();
      }));
    });
    return () => { cancelled = true; };
  }, [open, step, measure, steps.length]);

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
    dirRef.current = 1;
    setIndex((i) => (i >= steps.length - 1 ? (finish(), i) : i + 1));
  }, [steps.length, finish]);

  const back = useCallback(() => {
    dirRef.current = -1;
    setIndex((i) => Math.max(0, i - 1));
  }, []);

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
  if (resolving && step.target && !rect) {
    return <div className="tour-root"><div className="tour-overlay no-hole" /></div>;
  }

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
