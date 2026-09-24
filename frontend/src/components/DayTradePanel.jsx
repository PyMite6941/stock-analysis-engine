import { useEffect, useState } from "react";
import { daytrade as fetchDaytrade } from "../api.js";
import { big, money, num, pct } from "../format.js";

const REFRESH_MS = 60000;

// Intraday levels for day-trader mode: VWAP, opening range, floor pivots, ATR,
// how much of a typical day's range is already spent, and a position sizer.
//
// The sizer is the only thing on this page that isn't opinion — it's arithmetic,
// and it's the part that actually decides whether someone survives.
export default function DayTradePanel({ symbol, livePrice }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(
    () => localStorage.getItem("sae:account") || "");
  const [riskPct, setRiskPct] = useState(
    () => localStorage.getItem("sae:risk") || "1");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer;
    async function load(first) {
      if (first) setLoading(true);
      try {
        const d = await fetchDaytrade(symbol);
        if (!cancelled) { setData(d); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled && first) setLoading(false);
      }
    }
    load(true);
    timer = setInterval(() => load(false), REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [symbol]);

  useEffect(() => { localStorage.setItem("sae:account", account); }, [account]);
  useEffect(() => { localStorage.setItem("sae:risk", riskPct); }, [riskPct]);

  // Default the entry box to the live price so the sizer is usable immediately.
  useEffect(() => {
    if (!entry && (livePrice || data?.last)) {
      setEntry(String(livePrice || data.last));
    }
  }, [data, livePrice]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <section className="panel"><h2>⚡ Intraday</h2>
    <div className="skeleton" style={{ height: 220 }} /></section>;
  if (error) return <section className="panel"><h2>⚡ Intraday</h2>
    <p className="error-inline">⚠ {error}</p></section>;
  if (!data) return null;

  // A mutual fund is priced once daily at NAV — there is no session, no VWAP
  // and no opening range. Saying that is more useful than rendering a panel of
  // dashes, and far more useful than numbers derived from one daily print.
  if (data.applicable === false) {
    return (
      <section className="panel daytrade-panel">
        <h2>⚡ Intraday — {data.symbol}</h2>
        <p className="beginner-note" style={{ marginBottom: 0 }}>
          <strong>Not applicable here.</strong> {data.reason}
        </p>
      </section>
    );
  }

  const s = data.session || {};
  const p = data.pivots || {};
  const or = data.opening_range || {};
  const price = livePrice || data.last;
  const extended = s.range_used_pct > 100;
  const premarket = data.session_status === "premarket";

  // Position sizing, computed live so it responds as the entry/stop are typed.
  const acct = Number(account);
  const rp = Number(riskPct);
  const en = Number(entry);
  const st = Number(stop);
  const perShare = Math.abs(en - st);
  const sizing = (acct > 0 && rp > 0 && en > 0 && st > 0 && perShare > 0)
    ? {
      shares: Math.floor((acct * rp / 100) / perShare),
      riskDollars: acct * rp / 100,
      perShare,
      value: Math.floor((acct * rp / 100) / perShare) * en,
    }
    : null;

  const pivotRows = [
    ["R3", p.r3], ["R2", p.r2], ["R1", p.r1], ["Pivot", p.pivot],
    ["S1", p.s1], ["S2", p.s2], ["S3", p.s3],
  ].filter(([, v]) => v != null);

  return (
    <section className="panel daytrade-panel">
      <div className="panel-head">
        <h2>⚡ Intraday — {data.symbol}</h2>
        <span className="muted tiny">
          {data.session_date} · {s.bars || 0} bars · refreshes every 60s
        </span>
      </div>

      {data.continuous && (
        <p className="beginner-note">
          <strong>This market never closes.</strong> "Today" means the UTC
          calendar day, and the opening range is measured from UTC midnight —
          a convention, not a real opening bell. Pivots come from the previous
          UTC day.
        </p>
      )}

      {premarket && (
        <p className="beginner-note">
          <strong>Market closed.</strong> Everything below describes the last
          completed session ({data.session_date}), and the pivots are the levels
          for the session about to open. The "Last" price is the most recent
          print, including extended hours.
        </p>
      )}

      <div className="dt-strip">
        <div className="dt-stat">
          <span className="k">Last</span>
          <span className="v">{money(price)}</span>
          {s.change_pct != null && (
            <span className={`sub ${s.change_pct >= 0 ? "up" : "down"}`}>
              {s.change_pct >= 0 ? "+" : ""}{pct(s.change_pct)} today
            </span>
          )}
        </div>
        <div className="dt-stat">
          <span className="k">VWAP</span>
          <span className="v">{data.vwap ? `${money(data.vwap)}` : "—"}</span>
          {/* No volume (so no VWAP) is normal outside the session — don't
              render a bogus "above by 0%". */}
          <span className={`sub ${data.vs_vwap_pct >= 0 ? "up" : "down"}`}>
            {data.vwap == null || data.vs_vwap_pct == null
              ? "no session volume yet"
              : `${data.vs_vwap_pct >= 0 ? "above" : "below"} by ${pct(Math.abs(data.vs_vwap_pct))}`}
          </span>
        </div>
        <div className="dt-stat">
          <span className="k">
            {data.continuous ? "Today's range (UTC)"
              : premarket ? "Last session range" : "Session range"}
          </span>
          <span className="v">{money(s.low)}–{money(s.high)}</span>
          <span className="sub">{pct(s.range_pct)} wide</span>
        </div>
        <div className={`dt-stat ${extended ? "warn" : ""}`}>
          <span className="k">Range used</span>
          <span className="v">{pct(s.range_used_pct, 0)}</span>
          <span className="sub">of {`${money(s.atr)}`} ATR</span>
        </div>
        {s.gap_pct != null && (
          <div className="dt-stat">
            <span className="k">Gap</span>
            <span className={`v ${s.gap_pct >= 0 ? "up" : "down"}`}>
              {s.gap_pct >= 0 ? "+" : ""}{pct(s.gap_pct)}
            </span>
            <span className="sub">open vs prev close</span>
          </div>
        )}
        {s.volume != null && (
          <div className="dt-stat">
            <span className="k">Volume</span>
            <span className="v">{big(s.volume)}</span>
          </div>
        )}
      </div>

      {extended && (
        <p className="concentration-warn">
          ⚠ Today's range is already {pct(s.range_used_pct, 0)} of a typical day's
          move. Continuation entries here pay a wide stop for limited room.
        </p>
      )}

      {s.position_in_range_pct != null && (
        <div className="range-meter">
          <span className="rm-label">Low {money(s.low)}</span>
          <span className="rm-track">
            <span className="rm-fill" style={{ width: `${s.position_in_range_pct}%` }} />
            <span className="rm-marker" style={{ left: `${s.position_in_range_pct}%` }} />
          </span>
          <span className="rm-label">{money(s.high)} High</span>
        </div>
      )}

      <div className="dt-grid">
        <div className="forecast-card">
          <h3>Floor pivots</h3>
          <p className="muted small">
            From yesterday's {money(p.prev_low)}–{money(p.prev_high)} range.
          </p>
          <ul className="levels pivot-levels">
            {pivotRows.map(([label, v]) => {
              const dist = price ? ((v / price - 1) * 100) : null;
              const near = dist != null && Math.abs(dist) < 0.25;
              return (
                <li key={label}
                    className={`level ${label === "Pivot" ? "now" : label[0] === "R" ? "res" : "sup"}${near ? " near" : ""}`}>
                  <span className="level-tag">{label}</span>
                  <span className="level-price">{money(v)}</span>
                  <span className={`level-dist ${dist >= 0 ? "up" : "down"}`}>
                    {dist == null ? "" : `${dist >= 0 ? "+" : ""}${pct(dist)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="forecast-card">
          <h3>Opening range</h3>
          {or.high ? (
            <>
              <dl className="mini-stats">
                <div><dt>ORH</dt><dd>{money(or.high)}</dd></div>
                <div><dt>ORL</dt><dd>{money(or.low)}</dd></div>
                <div><dt>Width</dt><dd>{money(or.range)}</dd></div>
                <div><dt>Now</dt>
                  <dd className={price > or.high ? "up" : price < or.low ? "down" : ""}>
                    {price > or.high ? "broken up"
                      : price < or.low ? "broken down" : "inside"}
                  </dd></div>
              </dl>
              <p className="fine-print">First 30 minutes of the session.</p>
            </>
          ) : <p className="muted small">Not enough bars yet.</p>}

          {data.stops?.long && (
            <>
              <h3 className="sub-head">ATR stop distances</h3>
              <dl className="mini-stats">
                <div><dt>Long 1×</dt><dd>{money(data.stops.long.tight_1x)}</dd></div>
                <div><dt>Long 1.5×</dt><dd>{money(data.stops.long.normal_1_5x)}</dd></div>
                <div><dt>Short 1×</dt><dd>{money(data.stops.short.tight_1x)}</dd></div>
                <div><dt>Short 1.5×</dt><dd>{money(data.stops.short.normal_1_5x)}</dd></div>
              </dl>
            </>
          )}
        </div>

        <div className="forecast-card sizer">
          <h3>Position sizer</h3>
          <p className="muted small">
            How many shares keep the loss to a fixed slice of the account if the
            stop hits.
          </p>
          <div className="sizer-fields">
            <label><span>Account $</span>
              <input type="number" min="0" step="any" value={account} placeholder="25000"
                     onChange={(e) => setAccount(e.target.value)} /></label>
            <label><span>Risk %</span>
              <input type="number" min="0" max="100" step="0.1" value={riskPct}
                     onChange={(e) => setRiskPct(e.target.value)} /></label>
            <label><span>Entry $</span>
              <input type="number" min="0" step="any" value={entry}
                     onChange={(e) => setEntry(e.target.value)} /></label>
            <label><span>Stop $</span>
              <input type="number" min="0" step="any" value={stop}
                     placeholder={data.stops?.long?.normal_1_5x
                       ? String(data.stops.long.normal_1_5x) : "0.00"}
                     onChange={(e) => setStop(e.target.value)} /></label>
          </div>
          {sizing ? (
            <div className="sizer-result">
              <div className="sizer-shares">{num(sizing.shares, 0)}<em>shares</em></div>
              <dl className="mini-stats">
                <div><dt>Risking</dt><dd>{money(sizing.riskDollars)}</dd></div>
                <div><dt>Per share</dt><dd>{money(sizing.perShare)}</dd></div>
                <div><dt>Position</dt><dd>{money(sizing.value)}</dd></div>
                <div><dt>Of account</dt>
                  <dd className={sizing.value / acct > 1 ? "warn" : ""}>
                    {pct((sizing.value / acct) * 100, 0)}</dd></div>
              </dl>
              {sizing.value > acct && (
                <p className="fine-print warn-text">
                  That position costs more than the account holds — it needs margin,
                  or a wider stop with fewer shares.
                </p>
              )}
            </div>
          ) : (
            <p className="muted small">Fill in account, entry and stop to size a trade.</p>
          )}
        </div>
      </div>

      {data.intraday_volatility?.avg_bar_move_pct != null && (
        <p className="fine-print">
          Typical 5-minute move: {pct(data.intraday_volatility.avg_bar_move_pct, 3)};
          biggest today {pct(data.intraday_volatility.max_bar_move_pct, 3)}.
          ATR is {pct(s.atr_pct_of_price)} of price.
        </p>
      )}

      <p className="fine-print disclaimer-inline">
        Levels are reference points, not signals. Most day traders lose money;
        sizing decides how long you last. Not financial advice.
      </p>
    </section>
  );
}
