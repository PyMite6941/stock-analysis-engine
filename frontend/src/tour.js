// Guided tour: what each part of this page is for, in the order a new user
// actually needs it.
//
// The steps are data, not components, so adding one means adding an object
// rather than touching the renderer. Each step names a CSS selector to spotlight
// and the tour scrolls it into view — a description of a panel is far less
// useful than the panel itself, lit up, with the words next to it.
//
// Steps whose target isn't on the page are skipped automatically rather than
// pointing at nothing: the analysis page and the home page share this tour, and
// panels like Realised Gains only exist once you've recorded a sale.

export const LS_TOUR_SEEN = "sae:tour_seen";

// `mode` restricts a step to one experience mode; omit it to always show.
// `require` is a selector that must exist for the step to be worth showing.
export const STEPS = [
  {
    id: "welcome",
    title: "A quick tour",
    body: "Two minutes on what this tool does and where things live. You can "
      + "leave at any point with Escape, and reopen this with the ? button.",
    target: null,             // centred card, nothing highlighted
  },
  {
    id: "modes",
    title: "Pick how much detail you want",
    body: "Beginner explains every term as it goes and hides the jargon-heavy "
      + "panels. Standard is the full research view. Day Trader adds intraday "
      + "levels and position sizing. This changes the panels AND how the AI "
      + "analyst talks to you.",
    target: ".mode-switch",
  },
  {
    id: "search",
    title: "Search any stock, ETF, fund or coin",
    body: "Type a ticker — AAPL, SPY, VFIAX, BTC-USD. If it doesn't exist you "
      + "get told so immediately rather than a broken page. Crypto trades 24/7 "
      + "and mutual funds price once a day; the app adapts to each.",
    target: ".controls input, .search input",
  },
  {
    id: "chart",
    title: "The chart",
    body: "Switch timeframe and chart type, and toggle indicators — moving "
      + "averages, RSI, MACD, Bollinger Bands. The ✏ button lets you draw price "
      + "levels that persist between visits.",
    target: ".chart-section",
    scrollTo: true,
  },
  {
    id: "positions",
    title: "Track what you actually bought",
    body: "Record a purchase — shares, price paid, and optionally the exact time "
      + "for intraday trades. You get live profit and loss, and a Sell button "
      + "that matches against specific lots. Everything stays in this browser; "
      + "nothing is uploaded.",
    target: ".positions-panel",
    scrollTo: true,
  },
  {
    id: "export",
    title: "Get your data out in one click",
    body: "Export everything writes a single Excel file with every sheet — "
      + "holdings, performance, dividends, closed trades. Import reads files "
      + "straight from most brokers.",
    target: ".export-wrap",
  },
  {
    id: "forecast",
    title: "Projections, with the uncertainty shown",
    body: "A range of outcomes rather than a single prediction, plus a signal "
      + "score broken down by what drives it. Read the width of the range as the "
      + "real message: the further out, the less anyone knows.",
    target: ".forecast-panel",
    scrollTo: true,
  },
  {
    id: "backtest",
    title: "Check whether the signal has ever worked",
    body: "This one is unusual: it scores every day in the last five years and "
      + "measures what actually happened next. If the score has no predictive "
      + "value it says so in red. Most dashboards never check.",
    target: ".backtest-panel",
    scrollTo: true,
  },
  {
    id: "compare",
    title: "Two different meanings of 'gain'",
    body: "The stock's move over a period is not the same as your gain, which "
      + "is measured from what you paid. They often disagree in direction. Both "
      + "are shown side by side.",
    target: ".compare-panel",
    scrollTo: true,
  },
  {
    id: "diversification",
    title: "How many bets you really have",
    body: "Owning more tickers isn't the same as being diversified. This says "
      + "how many INDEPENDENT positions your holdings behave like, and whether "
      + "the limit is correlation or just position sizing.",
    target: ".correlation-panel",
    scrollTo: true,
  },
  {
    id: "alerts",
    title: "Alerts",
    body: "Price moves, percentage swings, or your own position gaining or "
      + "losing. They're checked in your browser, so they only fire while a tab "
      + "is open — the panel says so rather than letting you assume otherwise.",
    target: ".alerts-panel",
    scrollTo: true,
  },
  {
    id: "chat",
    title: "Ask the analyst",
    body: "It sees the same numbers you do — quotes, your positions, the "
      + "forecast — so it answers about what's on screen rather than in general. "
      + "It won't give buy or sell calls.",
    target: ".chat",
    scrollTo: true,
  },
  {
    id: "install",
    title: "Put it on your phone",
    body: "Add to Home Screen gives it its own icon and full-screen view, and "
      + "your positions keep working with no connection. Prices are labelled "
      + "with their age when they're not live.",
    target: ".pwa-bar.install",
  },
  {
    id: "done",
    title: "That's it",
    body: "Nothing here is financial advice, and the projections are statistics "
      + "rather than predictions. Reopen this tour any time with the ? button.",
    target: null,
  },
];

export function hasSeenTour() {
  try { return localStorage.getItem(LS_TOUR_SEEN) === "1"; } catch { return false; }
}

export function markTourSeen() {
  try { localStorage.setItem(LS_TOUR_SEEN, "1"); } catch { /* private mode */ }
}

export function resetTour() {
  try { localStorage.removeItem(LS_TOUR_SEEN); } catch { /* ignore */ }
}

/** A step is showable when it needs no target, or its target is on the page. */
export function stepVisible(step, mode) {
  if (step.mode && step.mode !== mode) return false;
  if (!step.target) return true;
  try {
    return Boolean(document.querySelector(step.target));
  } catch {
    return false;
  }
}

/** The steps worth showing right now, in order. */
export function visibleSteps(mode) {
  return STEPS.filter((s) => stepVisible(s, mode));
}

/**
 * Steps for this mode, WITHOUT checking whether their target is on the page.
 *
 * Filtering on DOM presence when the tour opens dropped every panel that loads
 * asynchronously — forecast, backtest, diversification all fetch after the page
 * renders, so they were absent at that instant and silently skipped. Presence
 * is now checked per step, when that step is reached, with a short wait.
 */
export function stepsForMode(mode) {
  return STEPS.filter((s) => !s.mode || s.mode === mode);
}

/** Resolve once `step`'s target exists, or null after `timeoutMs`. */
export function waitForTarget(step, timeoutMs = 1500) {
  if (!step?.target) return Promise.resolve(null);
  const found = targetElement(step);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const el = targetElement(step);
      if (el) return resolve(el);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** First element matching a step's (possibly comma-separated) target. */
export function targetElement(step) {
  if (!step?.target) return null;
  try {
    return document.querySelector(step.target);
  } catch {
    return null;
  }
}
