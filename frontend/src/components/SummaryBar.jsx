export default function SummaryBar({ summary }) {
  if (!summary) return null;
  const cards = [
    { label: "Symbols", value: summary.n_symbols },
    { label: "Gainers / Losers", value: `${summary.gainers} / ${summary.losers}` },
    { label: "Avg P/E", value: summary.avg_pe ?? "—" },
    {
      label: "Avg return %",
      value: summary.avg_total_return_pct ?? "—",
    },
  ];
  return (
    <div className="summary-bar">
      {cards.map((c) => (
        <div className="summary-card" key={c.label}>
          <div className="summary-value">{c.value}</div>
          <div className="summary-label">{c.label}</div>
        </div>
      ))}
      <div className="summary-note">
        Best <b>{summary.best_performer ?? "—"}</b> · Worst{" "}
        <b>{summary.worst_performer ?? "—"}</b> · Most volatile{" "}
        <b>{summary.most_volatile ?? "—"}</b>
      </div>
    </div>
  );
}
