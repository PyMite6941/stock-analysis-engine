function fmt(n, digits = 2) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtCap(n) {
  if (!n) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return fmt(n);
}

export default function QuoteTable({ quotes, analyses }) {
  const aBySym = Object.fromEntries(analyses.map((a) => [a.symbol, a]));
  return (
    <table className="quote-table">
      <thead>
        <tr>
          <th>Symbol</th><th>Name</th><th>Price</th><th>Chg %</th>
          <th>P/E</th><th>Mkt Cap</th><th>Return %</th><th>Vol %</th>
          <th>Max DD %</th><th>Trend</th>
        </tr>
      </thead>
      <tbody>
        {quotes.map((q) => {
          const a = aBySym[q.symbol] || {};
          const up = q.change_pct >= 0;
          return (
            <tr key={q.symbol}>
              <td className="sym">{q.symbol}</td>
              <td className="name">{q.name}</td>
              <td>{fmt(q.price)}</td>
              <td className={up ? "pos" : "neg"}>
                {up ? "▲" : "▼"} {fmt(q.change_pct)}
              </td>
              <td>{fmt(q.pe)}</td>
              <td>{fmtCap(q.market_cap)}</td>
              <td className={a.total_return_pct >= 0 ? "pos" : "neg"}>
                {fmt(a.total_return_pct)}
              </td>
              <td>{fmt(a.annualized_volatility_pct)}</td>
              <td className="neg">{fmt(a.max_drawdown_pct)}</td>
              <td><span className={`trend trend-${a.trend}`}>{a.trend}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
