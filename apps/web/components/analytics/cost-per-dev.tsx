"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { TelemetryCostPerDevPoint } from "@claude-hub/schema";

interface CostPerDevChartProps {
  data: TelemetryCostPerDevPoint[];
}

export function CostPerDevChart({ data }: CostPerDevChartProps) {
  const series = data.map((point) => ({
    day: point.day,
    perDev: point.activeDevs > 0 ? Number((point.cost / point.activeDevs).toFixed(2)) : 0,
    cost: Number(point.cost.toFixed(2)),
    activeDevs: point.activeDevs
  }));
  if (series.length === 0) {
    return <p className="analytics-empty">Pro vybrané období nejsou data.</p>;
  }
  return (
    <div className="analytics-chart-frame">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={series} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
          <XAxis
            dataKey="day"
            stroke="var(--muted)"
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickFormatter={formatDay}
          />
          <YAxis
            stroke="var(--muted)"
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickFormatter={(v) => `$${v}`}
            width={48}
          />
          <Tooltip
            cursor={{ stroke: "var(--accent-soft-strong)", strokeWidth: 1 }}
            contentStyle={tooltipStyle}
            itemStyle={{ color: "var(--ink)", fontSize: 12 }}
            labelStyle={{ color: "var(--ink)", marginBottom: 4, fontWeight: 600 }}
            labelFormatter={(label) => formatDay(String(label))}
            formatter={(value, key) => {
              const num = Number(value);
              if (key === "perDev") return [`$${num.toFixed(2)}`, "Cena/dev"];
              if (key === "cost") return [`$${num.toFixed(2)}`, "Celkem"];
              return [String(value), String(key)];
            }}
          />
          <Line
            type="monotone"
            dataKey="perDev"
            stroke="#F26B3D"
            strokeWidth={2}
            dot={{ r: 4, fill: "#F26B3D", strokeWidth: 0 }}
            activeDot={{ r: 6, fill: "#F26B3D", strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const tooltipStyle = {
  background: "var(--surface-2)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  boxShadow: "var(--shadow-md)",
  padding: "8px 10px"
};

function formatDay(value: string): string {
  // Vstup je ISO date (YYYY-MM-DD). Zkrátím na DD. MM.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[3])}. ${Number(match[2])}.`;
}
