"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { TelemetryModelMixRow } from "@claude-hub/schema";

interface ModelMixChartProps {
  data: TelemetryModelMixRow[];
}

const MODEL_COLORS: Record<string, string> = {
  sonnet: "#F26B3D",
  opus: "#93B5E1",
  haiku: "#4ADE80"
};

export function ModelMixChart({ data }: ModelMixChartProps) {
  if (data.length === 0) {
    return <p className="analytics-empty">Žádné token usage záznamy.</p>;
  }
  const byUser = new Map<string, { userId: string; total: number; counts: Record<string, number> }>();
  const families = new Set<string>();
  for (const row of data) {
    const family = familyFromModel(row.model);
    families.add(family);
    const existing = byUser.get(row.userId) ?? { userId: row.userId, total: 0, counts: {} };
    existing.counts[family] = (existing.counts[family] ?? 0) + row.tokens;
    existing.total += row.tokens;
    byUser.set(row.userId, existing);
  }
  const series = Array.from(byUser.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((row) => {
      const transformed: Record<string, number | string> = { userId: row.userId };
      for (const family of families) {
        const tokens = row.counts[family] ?? 0;
        transformed[family] = row.total > 0 ? Number(((tokens / row.total) * 100).toFixed(1)) : 0;
      }
      return transformed;
    });

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={series} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid stroke="#2A2A28" strokeDasharray="4 4" />
        <XAxis type="number" domain={[0, 100]} stroke="#8B8780" fontSize={11} tickFormatter={(v) => `${v}%`} />
        <YAxis type="category" dataKey="userId" stroke="#8B8780" fontSize={11} width={80} />
        <Tooltip
          contentStyle={{ background: "#1B1B1A", border: "1px solid #3A3A37", borderRadius: 8 }}
          formatter={(value, key) => [`${Number(value)} %`, String(key)]}
        />
        <Legend />
        {Array.from(families).map((family) => (
          <Bar key={family} dataKey={family} stackId="model" fill={MODEL_COLORS[family] ?? "#F4B547"} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function familyFromModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  return "ostatní";
}
