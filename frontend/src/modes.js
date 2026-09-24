// The three audiences the dashboard serves, and what each one sees.
//
// Mode is not a skin — it changes which panels render, how dense they are, and
// how the AI analyst writes. Someone who has never bought a stock and someone
// scalping the open need different screens, not the same screen with a
// different accent colour.

export const MODES = {
  beginner: {
    id: "beginner",
    label: "Beginner",
    icon: "🎓",
    tagline: "Plain English, jargon defined, the essentials only",
    // Panels intentionally hidden — valuation ratios and raw indicator tables
    // are noise before you know what a P/E is.
    hide: ["statistics", "daytrade"],
    showGlossary: true,
    chartDefaults: { type: "area", indicators: ["sma50"], timeframe: "6mo" },
  },
  standard: {
    id: "standard",
    label: "Standard",
    icon: "📊",
    tagline: "The full research dashboard",
    hide: ["daytrade"],
    showGlossary: false,
    chartDefaults: { type: "candles", indicators: ["sma50", "sma200"], timeframe: "6mo" },
  },
  daytrader: {
    id: "daytrader",
    label: "Day Trader",
    icon: "⚡",
    tagline: "Intraday levels, open positions, live P/L",
    hide: [],
    showGlossary: false,
    chartDefaults: { type: "candles", indicators: ["ema20", "vwap"], timeframe: "1D" },
  },
};

export const MODE_ORDER = ["beginner", "standard", "daytrader"];

export const LS_MODE = "sae:mode";

export function getMode(id) {
  return MODES[id] || MODES.standard;
}

export function loadMode() {
  const saved = localStorage.getItem(LS_MODE);
  return MODES[saved] ? saved : "standard";
}

export function saveMode(id) {
  if (MODES[id]) localStorage.setItem(LS_MODE, id);
}

export function isHidden(modeId, panel) {
  return getMode(modeId).hide.includes(panel);
}

// Plain-English definitions surfaced as tooltips in beginner mode. Deliberately
// short — a definition someone has to read twice has failed.
export const GLOSSARY = {
  "P/E": "Price-to-earnings. The share price divided by yearly profit per share. Roughly: how many years of current profits you're paying for. Higher means the market expects growth — or that it's expensive.",
  "Market cap": "The whole company's price tag: share price × number of shares. It's what you'd pay to buy the entire business.",
  Volatility: "How much the price jumps around. High volatility means bigger swings in both directions — more chance to gain, more chance to lose.",
  "Max drawdown": "The worst peak-to-bottom fall in the period. If it says -30%, someone who bought at the high was down 30% at the low point.",
  "Total return": "How much the price changed over the whole period you're looking at, as a percentage.",
  Trend: "Whether the price is above or below its own recent averages. Above = uptrend, below = downtrend. It describes the past, it doesn't promise the future.",
  RSI: "Relative Strength Index, 0–100. Above 70 often means the stock has run hot recently; below 30 means it's been beaten down. It's a speed gauge, not a buy or sell signal.",
  MACD: "A momentum gauge built from two moving averages. When the bars flip from negative to positive, upward momentum is building.",
  "Bollinger Bands": "A channel drawn two standard deviations above and below the average price. Price near the top edge is stretched high; near the bottom, stretched low.",
  "Moving average": "The average closing price over the last N days, redrawn each day. It smooths out the noise so the underlying direction shows.",
  Volume: "How many shares changed hands. A big price move on big volume means more people agreed with it.",
  Beta: "How much the stock moves relative to the whole market. Beta 2 means it tends to swing twice as hard as the market, up and down.",
  Dividend: "A cash payment some companies send shareholders, usually quarterly. The yield is that cash as a percentage of the share price.",
  "Cost basis": "What you actually paid per share. Your gain or loss is measured from here.",
  "Unrealised P/L": "Profit or loss on paper — what you'd make or lose if you sold right now. It isn't real money until you actually sell.",
  "Expense ratio": "The yearly fee a fund charges, as a percentage of what you hold. 0.03% on $10,000 is $3 a year. Small differences compound enormously over decades.",
  ETF: "Exchange-traded fund. One ticker that holds a basket of many companies, so buying one share buys a slice of all of them.",
  "Index fund": "A fund that simply holds everything in a published list (like the S&P 500) rather than picking winners. Cheap, and historically hard to beat.",
  Sharpe: "Return earned per unit of risk taken. Above 1 is generally considered good; below 0 means you'd have done better in cash.",
  VaR: "Value at Risk. The '95% VaR' is roughly the loss you'd expect to exceed on the worst 1 day in 20.",
  VWAP: "Volume-weighted average price for today. Day traders treat it as the session's fair value — above it is strength, below it is weakness.",
  ATR: "Average True Range: how far this stock typically travels in a day, in dollars. It's the standard way to size a stop so you're not stopped out by normal noise.",
  "Support / resistance": "Prices where the stock has repeatedly stopped falling (support) or stopped rising (resistance). They're where other traders are watching, which is much of why they matter.",
  "Pivot points": "Levels calculated from yesterday's high, low and close. Widely watched intraday, which makes them partly self-fulfilling.",
  Drawdown: "How far the price has fallen from its most recent peak.",
  "Stop-loss": "A price you decide in advance to sell at if the trade goes against you. It turns 'how wrong can this get?' into a number you picked while calm.",
  "Reward : risk": "How much you stand to make at your target for every $1 you'd lose at your stop. At 2 : 1 you only need to be right about 1 time in 3 to come out ahead.",
  "Paper trading": "Buying and selling with pretend money at real prices. All the practice, none of the cost — the standard way to learn before risking anything.",
  "Market movers": "The stocks with the biggest % change today, up or down. A big move usually means news — earnings, a lawsuit, an analyst call.",
  Concentration: "How much of your money sits in one holding. A single position over about a third of your portfolio means your outcome is really just that one bet.",
};
