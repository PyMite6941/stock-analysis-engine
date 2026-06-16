import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

export default function PriceChart({ symbol, history }) {
  if (!history?.closes?.length) {
    return (
      <div className="chart-card">
        <h3>{symbol}</h3>
        <p className="muted">No history available.</p>
      </div>
    );
  }
  const series = history.dates.map((d, i) => ({ date: d, close: history.closes[i] }));
  const up = history.closes.at(-1) >= history.closes[0];
  return (
    <div className="chart-card">
      <h3>{symbol}</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={series} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
          <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} width={48} />
          <Tooltip
            contentStyle={{ background: "#111", border: "1px solid #333" }}
            labelStyle={{ color: "#aaa" }}
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke={up ? "#3fb950" : "#f85149"}
            dot={false}
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
