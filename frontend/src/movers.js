// Today's biggest movers — Yahoo Finance's "Top gainers / Top losers".
//
// Real market-wide movers need a feed that scans every listed stock, and free
// APIs don't offer one. So this ranks a fixed list of the largest, most-watched
// US companies instead, and the UI says so. It's the same idea on a smaller
// pond: the list is who the news is about on most days anyway.

// [ticker, company name]. Names are here so direct mode doesn't spend 30 extra
// API calls looking them up.
export const UNIVERSE = [
  ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "NVIDIA"],
  ["AMZN", "Amazon"], ["GOOGL", "Alphabet"], ["META", "Meta Platforms"],
  ["TSLA", "Tesla"], ["BRK-B", "Berkshire Hathaway"], ["AVGO", "Broadcom"],
  ["JPM", "JPMorgan Chase"], ["LLY", "Eli Lilly"], ["V", "Visa"],
  ["UNH", "UnitedHealth"], ["XOM", "Exxon Mobil"], ["MA", "Mastercard"],
  ["COST", "Costco"], ["HD", "Home Depot"], ["PG", "Procter & Gamble"],
  ["JNJ", "Johnson & Johnson"], ["NFLX", "Netflix"], ["WMT", "Walmart"],
  ["BAC", "Bank of America"], ["AMD", "AMD"], ["KO", "Coca-Cola"],
  ["CRM", "Salesforce"], ["ORCL", "Oracle"], ["PEP", "PepsiCo"],
  ["DIS", "Disney"], ["INTC", "Intel"], ["PLTR", "Palantir"],
];

export const UNIVERSE_SYMBOLS = UNIVERSE.map(([s]) => s);
export const UNIVERSE_NAMES = Object.fromEntries(UNIVERSE);

/**
 * Split quotes into the top `n` gainers and top `n` losers by % change.
 * A stock only counts as a gainer if it's actually up (and a loser if down),
 * so on a day when everything rose, the "losers" list is honestly short.
 */
export function rankMovers(quotes, n = 5) {
  const usable = (quotes || []).filter(
    (q) => q && !q.not_found && Number.isFinite(q.change_pct));
  const byChange = [...usable].sort((a, b) => b.change_pct - a.change_pct);
  return {
    gainers: byChange.filter((q) => q.change_pct > 0).slice(0, n),
    losers: byChange.filter((q) => q.change_pct < 0).reverse().slice(0, n),
  };
}
