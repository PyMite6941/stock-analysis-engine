// Is the market open, and how old is this price?
//
// A number on screen means nothing without those two facts. $338.98 is a
// quote during the session, a closing price at midnight, and a guess if it
// arrived twenty minutes ago and the connection has since dropped — but it
// looks identical in all three cases unless something says otherwise.
//
// Everything here is computed from the browser clock converted to New York
// time, with no network call: a status line that needs a request to tell you
// the connection is down is the wrong shape.
//
// Two caveats, stated rather than hidden:
//   - Market HOLIDAYS are not modelled. Holidays move, and a hardcoded list
//     silently rots into wrong answers. A holiday reads as "open" here, and
//     the price age is what actually catches it — no ticks arrive, so the
//     clock climbs and the label goes stale on its own.
//   - Crypto never closes, so `continuous` assets skip session logic entirely.

const OPEN_MINUTES = 9 * 60 + 30;        // 09:30 ET
const CLOSE_MINUTES = 16 * 60;           // 16:00 ET
const PRE_MINUTES = 4 * 60;              // 04:00 ET, pre-market open
const POST_MINUTES = 20 * 60;            // 20:00 ET, after-hours close

// How long without an update before a price stops being "current". Generous
// enough to survive a thin tape on a quiet stock, short enough to catch a
// dropped socket.
export const STALE_AFTER_MS = 2 * 60 * 1000;

/** Wall-clock minutes past midnight in New York, and the weekday there. */
export function newYorkTime(now = new Date()) {
  // Intl is the only correct way to do this in a browser: it applies the DST
  // rules for the date in question instead of a fixed UTC offset, so this
  // keeps working across the March and November transitions.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  let hour = Number(get("hour"));
  // en-US with hour12:false renders midnight as "24" in some engines.
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  const weekday = get("weekday");
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .indexOf(weekday);

  return { minutes: hour * 60 + minute, weekday, dayIndex };
}

/**
 * Session state for a US-listed asset.
 *
 * Returns one of: "open", "premarket", "afterhours", "closed", "weekend",
 * plus a label and whether prices should be expected to move.
 */
export function marketStatus(now = new Date(), { continuous = false } = {}) {
  if (continuous) {
    return { state: "open", label: "24/7 market", live: true, continuous: true };
  }

  const { minutes, dayIndex } = newYorkTime(now);
  if (dayIndex === 0 || dayIndex === 6) {
    return { state: "weekend", label: "Market closed — weekend", live: false };
  }
  if (minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES) {
    return { state: "open", label: "Market open", live: true };
  }
  if (minutes >= PRE_MINUTES && minutes < OPEN_MINUTES) {
    return { state: "premarket", label: "Pre-market", live: true };
  }
  if (minutes >= CLOSE_MINUTES && minutes < POST_MINUTES) {
    return { state: "afterhours", label: "After hours", live: true };
  }
  return { state: "closed", label: "Market closed", live: false };
}

/** "just now", "40s ago", "3m ago", "2h ago" — an age, not a timestamp. */
export function ago(ts, now = Date.now()) {
  if (!ts) return null;
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/**
 * How a price should be presented, given when it arrived and what the market
 * is doing.
 *
 * The distinction that matters: a price that has not moved for an hour is
 * perfectly correct when the market is shut, and a warning sign when it is
 * open. Same number, same age, opposite meaning — so staleness is only ever
 * claimed during a session.
 */
export function priceFreshness({ lastTick, lastPoll, streaming = false,
                                 continuous = false, now = Date.now() }) {
  const status = marketStatus(new Date(now), { continuous });
  const newest = Math.max(lastTick || 0, lastPoll || 0) || null;
  const age = newest ? now - newest : null;

  if (!newest) {
    return { ...status, source: "none", age: null, stale: false,
             text: "Waiting for prices…" };
  }

  const source = (lastTick && lastTick >= (lastPoll || 0)) ? "stream" : "poll";
  const stale = Boolean(status.live && age > STALE_AFTER_MS);

  let text;
  if (stale) {
    text = `Prices ${ago(newest, now)} — not updating`;
  } else if (source === "stream" && streaming) {
    text = `Live · updated ${ago(newest, now)}`;
  } else if (status.live) {
    text = `Updated ${ago(newest, now)}`;
  } else {
    // Outside the session the number is the last traded price, which is a
    // fact rather than a stale quote. Say that instead of nagging.
    text = `${status.label} · last price ${ago(newest, now)}`;
  }

  return { ...status, source, age, stale, text, at: newest };
}

// Display-only shortcut for "this thing never closes".
//
// core/assets.py is authoritative — it classifies from the provider's own
// quote type. This exists so the status line can render before that round trip
// lands, and matches the pair format the app uses everywhere (BTC-USD).
const CONTINUOUS_RE = /-(USD|USDT|EUR|GBP)$/;

export function looksContinuous(symbol) {
  return CONTINUOUS_RE.test(String(symbol || "").toUpperCase());
}

/** True only when EVERY symbol on screen trades around the clock. */
export function allContinuous(symbols) {
  const list = (symbols || []).filter(Boolean);
  return list.length > 0 && list.every(looksContinuous);
}
