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
  userEmailById: Map<string, string>;
}

const MODEL_COLORS: Record<string, string> = {
  sonnet: "var(--accent)",
  opus: "var(--info)",
  haiku: "var(--success)",
  ostatní: "var(--warning)"
};

export function ModelMixChart({ data, userEmailById }: ModelMixChartProps) {
  if (data.length === 0) {
    return <p className="analytics-empty">Žádné token usage záznamy.</p>;
  }
  const byUser = new Map<string, { userId: string; label: string; total: number; counts: Record<string, number> }>();
  const families = new Set<string>();
  for (const row of data) {
    const family = familyFromModel(row.model);
    families.add(family);
    const label = userEmailById.get(row.userId) ?? shortenUserId(row.userId);
    const existing = byUser.get(row.userId) ?? { userId: row.userId, label, total: 0, counts: {} };
    existing.counts[family] = (existing.counts[family] ?? 0) + row.tokens;
    existing.total += row.tokens;
    byUser.set(row.userId, existing);
  }
  const series = Array.from(byUser.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((row) => {
      const transformed: Record<string, number | string> = { label: row.label, userId: row.userId };
      for (const family of families) {
        const tokens = row.counts[family] ?? 0;
        transformed[family] = row.total > 0 ? Number(((tokens / row.total) * 100).toFixed(1)) : 0;
      }
      return transformed;
    });

  const chartHeight = Math.max(160, series.length * 38 + 60);
  const longestLabel = series.reduce(
    (acc, row) => Math.max(acc, String(row.label ?? "").length),
    0
  );
  const yAxisWidth = Math.min(200, Math.max(70, longestLabel * 7 + 12));

  return (
    <div className="analytics-chart-frame">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={series}
          layout="vertical"
          margin={{ top: 4, right: 24, left: 0, bottom: 0 }}
          barCategoryGap="30%"
        >
          <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 100]}
            stroke="var(--muted)"
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickFormatter={(v) => `${v}%`}
          />
          <YAxis
            type="category"
            dataKey="label"
            stroke="var(--muted)"
            tick={{ fill: "var(--ink-muted)", fontSize: 11 }}
            width={yAxisWidth}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            contentStyle={tooltipStyle}
            itemStyle={{ color: "var(--ink)", fontSize: 12 }}
            labelStyle={{ color: "var(--ink)", marginBottom: 4, fontWeight: 600 }}
            formatter={(value, key) => [`${Number(value)} %`, String(key)]}
          />
          <Legend
            iconType="circle"
            wrapperStyle={{ fontSize: 12, color: "var(--ink-muted)", paddingTop: 8 }}
          />
          {Array.from(families).map((family, index, all) => (
            <Bar
              key={family}
              dataKey={family}
              stackId="model"
              fill={MODEL_COLORS[family] ?? "var(--warning)"}
              maxBarSize={24}
              radius={resolveRadius(index, all.length)}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
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

function resolveRadius(index: number, total: number): [number, number, number, number] {
  if (total === 1) return [4, 4, 4, 4];
  if (index === 0) return [4, 0, 0, 4];
  if (index === total - 1) return [0, 4, 4, 0];
  return [0, 0, 0, 0];
}

function shortenUserId(userId: string): string {
  if (userId.length <= 14) return userId;
  return `${userId.slice(0, 6)}…${userId.slice(-4)}`;
}

function familyFromModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  return "ostatní";
}
