// Position sizing and risk/reward — plain arithmetic, no data needed.
//
// This is the one tool every day trader should use on every trade, and it
// works with no server and no API key. The idea: decide how much you're
// willing to LOSE first (say 1% of the account), and let that decide how many
// shares you buy. Then a stop-loss hit is a planned, survivable loss.

/**
 * @param account   account size in $
 * @param riskPct   % of the account you'll lose if the stop is hit
 * @param entry     price you buy (or short) at
 * @param stop      price you'll get out at if wrong
 * @param target    optional price you'll take profit at
 * Returns null when the inputs can't make a trade (e.g. stop == entry).
 */
export function sizePosition({ account, riskPct, entry, stop, target = null }) {
  const a = Number(account);
  const r = Number(riskPct);
  const e = Number(entry);
  const s = Number(stop);
  if (!(a > 0) || !(r > 0) || !(e > 0) || !(s > 0) || e === s) return null;

  const side = s < e ? "long" : "short";   // stop below entry = you're buying
  const riskPerShare = Math.abs(e - s);
  const riskBudget = a * (r / 100);
  // Whole shares only, and never more than the account can pay for.
  const shares = Math.max(0, Math.min(Math.floor(riskBudget / riskPerShare), Math.floor(a / e)));
  const positionValue = shares * e;

  const out = {
    side,
    riskPerShare,
    riskBudget,
    shares,
    positionValue,
    maxLoss: shares * riskPerShare,
    pctOfAccount: (positionValue / a) * 100,
    // True when buying power, not risk, set the size — worth telling the user.
    cappedByCash: Math.floor(riskBudget / riskPerShare) > Math.floor(a / e),
    reward: null,
    rewardRisk: null,
    targetOnWrongSide: false,
  };

  const t = Number(target);
  if (target !== null && target !== "" && t > 0) {
    const rewardPerShare = side === "long" ? t - e : e - t;
    out.targetOnWrongSide = rewardPerShare <= 0;
    out.reward = shares * rewardPerShare;
    out.rewardRisk = rewardPerShare / riskPerShare;
  }
  return out;
}

/**
 * How often a trade with this reward:risk has to win just to break even.
 * At 2:1 you only need to be right 1 time in 3.
 */
export function breakEvenWinRate(rewardRisk) {
  if (!(rewardRisk > 0)) return null;
  return (1 / (1 + rewardRisk)) * 100;
}
