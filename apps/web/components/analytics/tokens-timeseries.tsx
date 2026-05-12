"use client";

import {
  AreaChart,
  Area,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { TelemetryDailyTeamPoint } from "@claude-hub/schema";

interface TokensTimeseriesProps {
  data: TelemetryDailyTeamPoint[];
}

export function TokensTimeseries({ data }: TokensTimeseriesProps) {
  if (data.length === 0) {
    return <p className="analytics-empty">Pro vybrané období nejsou data.</p>;
  }
  return (
    <div className="analytics-chart-frame">
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="tokensFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#F26B3D" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#F26B3D" stopOpacity={0.05} />
            </linearGradient>
          </defs>
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
            tickFormatter={(v) => formatShort(Number(v))}
            width={48}
          />
          <Tooltip
            cursor={{ stroke: "var(--accent-soft-strong)", strokeWidth: 1 }}
            contentStyle={tooltipStyle}
            itemStyle={{ color: "var(--ink)", fontSize: 12 }}
            labelStyle={{ color: "var(--ink)", marginBottom: 4, fontWeight: 600 }}
            labelFormatter={(label) => formatDay(String(label))}
            formatter={(value) => Math.round(Number(value)).toLocaleString("cs-CZ")}
          />
          <Legend
            iconType="circle"
            wrapperStyle={{ fontSize: 12, color: "var(--ink-muted)", paddingTop: 8 }}
          />
          <Area
            type="monotone"
            dataKey="tokensTotal"
            name="Tokeny"
            stroke="#F26B3D"
            fill="url(#tokensFill)"
            strokeWidth={2}
            dot={{ r: 3, fill: "#F26B3D", strokeWidth: 0 }}
            activeDot={{ r: 5, fill: "#F26B3D", strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </AreaChart>
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
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[3])}. ${Number(match[2])}.`;
}

function formatShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
