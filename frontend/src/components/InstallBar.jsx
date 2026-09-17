import { useEffect, useState } from "react";
import {
  canInstall, dismissInstall, installDismissed, isIos, isOffline, isStandalone,
  promptInstall, staleData, subscribe,
} from "../pwa.js";

// Install prompt, offline notice and update notice — the three things a phone
// user needs the page itself to tell them.
//
// The offline banner is the one that matters most here. This is a finance app,
// and a cached price shown without comment is worse than no price at all, so
// when the connection drops the page says so in a bar you cannot miss rather
// than quietly serving yesterday's numbers.
// "3 minutes ago" — a stale price needs an age, not just a warning.
function ago(when) {
  const secs = Math.max(0, (Date.now() - when.getTime()) / 1000);
  if (secs < 90) return "moments ago";
  const mins = secs / 60;
  if (mins < 60) return `${Math.round(mins)} min ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function InstallBar() {
  const [installable, setInstallable] = useState(canInstall);
  const [offline, setOffline] = useState(isOffline);
  const [update, setUpdate] = useState(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(installDismissed);
  const [stale, setStale] = useState(staleData);

  useEffect(() => subscribe((s) => {
    if (s.type === "install-available") setInstallable(true);
    if (s.type === "install-unavailable" || s.type === "installed") setInstallable(false);
    if (s.type === "install-dismissed") setDismissed(true);
    if (s.type === "offline") setOffline(true);
    if (s.type === "online") setOffline(false);
    if (s.type === "update-available") setUpdate(() => s.apply);
    if (s.type === "stale") setStale(s.at);
    if (s.type === "fresh") setStale(null);
  }), []);

  const standalone = isStandalone();
  // iOS never fires beforeinstallprompt, so the only honest thing to do is
  // describe the Share-sheet route rather than show a button that can't work.
  const iosCandidate = isIos() && !standalone && !dismissed;

  return (
    <>
      {offline && (
        <div className="pwa-bar offline" role="status">
          <span className="pwa-dot" aria-hidden="true">●</span>
          <span>
            <strong>Offline.</strong> Your positions and everything you've saved
            still work. Prices are the last ones loaded — <strong>not live</strong>
            {stale ? ` (${ago(stale)})` : ""}.
          </span>
        </div>
      )}

      {/* Connected, but the API failed and the worker served a cached copy.
          navigator.onLine can't detect this, and unmarked stale prices are
          exactly what this feature exists to prevent. */}
      {!offline && stale && (
        <div className="pwa-bar stale" role="status">
          <span className="pwa-dot" aria-hidden="true">●</span>
          <span>
            <strong>Showing saved data.</strong> Couldn't reach live prices, so
            these are from {ago(stale)}. Your own positions and costs are exact.
          </span>
        </div>
      )}

      {update && (
        <div className="pwa-bar update" role="status">
          <span>A new version is ready.</span>
          <button className="pwa-btn" onClick={update}>Reload</button>
        </div>
      )}

      {!offline && !standalone && !dismissed && (installable || iosCandidate) && (
        <div className="pwa-bar install">
          <span className="pwa-icon" aria-hidden="true">📲</span>
          <span className="pwa-copy">
            <strong>Add to your home screen</strong>
            <em>
              {iosCandidate
                ? "Opens full screen and works without a connection."
                : "Full screen, own icon, and your portfolio works offline."}
            </em>
          </span>
          {installable ? (
            <button className="pwa-btn primary" onClick={promptInstall}>Install</button>
          ) : (
            <button className="pwa-btn" onClick={() => setShowIosHint((v) => !v)}>
              How?
            </button>
          )}
          <button className="pwa-x" aria-label="Dismiss"
                  onClick={() => { dismissInstall(); setDismissed(true); }}>✕</button>
        </div>
      )}

      {showIosHint && (
        <div className="pwa-bar ios-hint">
          <span>
            Tap <strong>Share</strong> <span aria-hidden="true">⬆️</span> at the
            bottom of Safari, then <strong>Add to Home Screen</strong>.
            Safari doesn't allow a one-tap install button.
          </span>
        </div>
      )}
    </>
  );
}
