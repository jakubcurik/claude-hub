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
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#2A2A28" strokeDasharray="4 4" />
        <XAxis dataKey="day" stroke="#8B8780" fontSize={11} />
        <YAxis stroke="#8B8780" fontSize={11} tickFormatter={(v) => `$${v}`} />
        <Tooltip
          contentStyle={{ background: "#1B1B1A", border: "1px solid #3A3A37", borderRadius: 8 }}
          formatter={(value, key) => {
            const num = Number(value);
            if (key === "perDev") return [`$${num.toFixed(2)}`, "Cena/dev"];
            if (key === "cost") return [`$${num.toFixed(2)}`, "Celkem"];
            return [String(value), String(key)];
          }}
        />
        <Line type="monotone" dataKey="perDev" stroke="#F26B3D" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
