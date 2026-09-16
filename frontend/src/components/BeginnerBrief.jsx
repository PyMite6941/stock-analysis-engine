import { big, num, pct } from "../format.js";
import Explain from "./Explain.jsx";

// "What this actually means" — the dashboard in plain English.
//
// Deliberately NOT AI-generated: it must be correct, instant, and identical for
// the same numbers every time. The AI analyst sits alongside for follow-up
// questions; this is the part a beginner reads first and can trust.
export default function BeginnerBrief({ quote, analysis, fund }) {
  if (!quote || !analysis) return null;

  const up = quote.change_pct >= 0;
  const ret = analysis.total_return_pct;
  const vol = analysis.annualized_volatility_pct;
  const dd = analysis.max_drawdown_pct;

  const volWord = vol > 60 ? "very jumpy" : vol > 35 ? "fairly jumpy"
    : vol > 20 ? "moderately steady" : "relatively steady";
  const trendWord = {
    "strong-uptrend": "clearly trending up",
    uptrend: "drifting up",
    downtrend: "drifting down",
    "strong-downtrend": "clearly trending down",
    "insufficient-data": "hard to read — not enough history",
  }[analysis.trend] || analysis.trend;

  // $1,000 is a more legible unit than a percentage for someone new.
  const thousand = ret != null ? 1000 * (1 + ret / 100) : null;

  return (
    <section className="panel beginner-brief">
      <h2>💡 What this means, in plain English</h2>

      <p className="brief-lead">
        <strong>{quote.name}</strong> ({quote.symbol}) trades at{" "}
        <strong>${num(quote.price)}</strong>, {up ? "up" : "down"}{" "}
        <strong className={up ? "up" : "down"}>{pct(Math.abs(quote.change_pct))}</strong>{" "}
        today.
        {quote.market_cap ? (
          <> The whole company is worth about{" "}
            <Explain term="Market cap">${big(quote.market_cap)}</Explain>.</>
        ) : null}
      </p>

      <ul className="brief-points">
        {ret != null && (
          <li>
            <span className="brief-icon">{ret >= 0 ? "📈" : "📉"}</span>
            <span>
              Over the period shown it's {ret >= 0 ? "gained" : "lost"}{" "}
              <strong className={ret >= 0 ? "up" : "down"}>{pct(Math.abs(ret))}</strong>.
              ${num(1000, 0)} invested at the start would be worth about{" "}
              <strong>${num(thousand, 0)}</strong> now.
            </span>
          </li>
        )}
        {vol != null && (
          <li>
            <span className="brief-icon">🎢</span>
            <span>
              It's <strong>{volWord}</strong> — <Explain term="Volatility">
              volatility</Explain> of {pct(vol)} a year. Higher means bigger swings
              both ways, so both the wins and the losses are larger.
            </span>
          </li>
        )}
        {dd != null && (
          <li>
            <span className="brief-icon">⚠️</span>
            <span>
              Its worst fall in this period was{" "}
              <strong className="down">{pct(Math.abs(dd))}</strong>{" "}
              (<Explain term="Max drawdown">max drawdown</Explain>). Anyone who
              bought right at the top was down that much before it recovered — if
              it recovered.
            </span>
          </li>
        )}
        <li>
          <span className="brief-icon">🧭</span>
          <span>
            The price is <strong>{trendWord}</strong> compared with its own recent
            averages. That describes what already happened; it is not a promise
            about tomorrow.
          </span>
        </li>
        {quote.pe ? (
          <li>
            <span className="brief-icon">🏷️</span>
            <span>
              Its <Explain term="P/E">P/E</Explain> is {num(quote.pe)} — you're
              paying about {num(quote.pe, 0)} years of current profits for a share.
              {quote.pe > 40 ? " That's expensive, so the market is pricing in a lot of future growth."
                : quote.pe < 15 ? " That's on the cheap side, which sometimes signals a bargain and sometimes signals trouble."
                : " That's around the middle of the usual range."}
            </span>
          </li>
        ) : null}
        {fund?.is_fund && (
          <li>
            <span className="brief-icon">🧺</span>
            <span>
              This is a <Explain term="Index fund">fund</Explain>, not a single
              company — buying it spreads your money across many businesses at
              once. See the breakdown below for exactly which ones.
            </span>
          </li>
        )}
      </ul>

      <p className="fine-print">
        The three things that matter most when you're starting: don't put
        everything in one name, don't buy something only because it already went
        up, and only invest money you won't need soon. Not financial advice.
      </p>
    </section>
  );
}
