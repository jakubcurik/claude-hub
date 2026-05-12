"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { TelemetryProjectAggregate } from "@claude-hub/schema";

interface PerProjectChartProps {
  data: TelemetryProjectAggregate[];
  onSelect: (projectPath: string) => void;
}

export function PerProjectChart({ data, onSelect }: PerProjectChartProps) {
  if (data.length === 0) {
    return <p className="analytics-empty">Žádná data per projekt.</p>;
  }
  const series = data.map((row) => ({
    projectPath: row.projectPath || "(nepřiřazené)",
    label: row.projectPath ? short(row.projectPath) : "(nepřiřazené)",
    tokens: row.tokens,
    cost: Number(row.costUsd.toFixed(2))
  }));
  const chartHeight = Math.max(180, series.length * 36 + 40);

  return (
    <div className="analytics-chart-frame">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={series}
          layout="vertical"
          margin={{ top: 4, right: 56, left: 8, bottom: 0 }}
          barCategoryGap="30%"
        >
          <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" horizontal={false} />
          <XAxis
            type="number"
            stroke="var(--muted)"
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickFormatter={(v) => formatShort(Number(v))}
          />
          <YAxis
            type="category"
            dataKey="label"
            stroke="var(--muted)"
            tick={{ fill: "var(--ink-muted)", fontSize: 11 }}
            width={170}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            contentStyle={tooltipStyle}
            itemStyle={{ color: "var(--ink)", fontSize: 12 }}
            labelStyle={{ color: "var(--ink)", marginBottom: 4, fontWeight: 600 }}
            formatter={(value, key) => {
              if (key === "tokens") return [formatShort(Number(value)), "Tokeny"];
              return [String(value), String(key)];
            }}
          />
          <Bar
            dataKey="tokens"
            radius={[4, 4, 4, 4]}
            maxBarSize={22}
            isAnimationActive={false}
            onClick={(payload) => {
              const projectPath = (payload as { projectPath?: string }).projectPath ?? "";
              onSelect(projectPath === "(nepřiřazené)" ? "" : projectPath);
            }}
          >
            {series.map((entry) => (
              <Cell key={entry.projectPath} fill="var(--accent)" cursor="pointer" />
            ))}
            <LabelList
              dataKey="tokens"
              position="right"
              formatter={(value) => formatShort(Number(value ?? 0))}
              style={{ fill: "var(--ink-muted)", fontSize: 11 }}
            />
          </Bar>
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

function short(value: string): string {
  if (value.length <= 28) return value;
  return `…${value.slice(-26)}`;
}

function formatShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
