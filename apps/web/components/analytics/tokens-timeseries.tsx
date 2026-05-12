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
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="tokensFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#F26B3D" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#F26B3D" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#2A2A28" strokeDasharray="4 4" />
        <XAxis dataKey="day" stroke="#8B8780" fontSize={11} />
        <YAxis stroke="#8B8780" fontSize={11} tickFormatter={(v) => formatShort(Number(v))} />
        <Tooltip
          contentStyle={{ background: "#1B1B1A", border: "1px solid #3A3A37", borderRadius: 8 }}
          labelStyle={{ color: "#F5F4ED" }}
          formatter={(value) => Math.round(Number(value)).toLocaleString("cs-CZ")}
        />
        <Legend />
        <Area
          type="monotone"
          dataKey="tokensTotal"
          name="Tokeny"
          stroke="#F26B3D"
          fill="url(#tokensFill)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function formatShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
