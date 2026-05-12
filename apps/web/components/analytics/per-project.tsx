"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
    tokens: row.tokens,
    cost: Number(row.costUsd.toFixed(2))
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={series} layout="vertical" margin={{ top: 8, right: 16, left: 16, bottom: 0 }}>
        <CartesianGrid stroke="#2A2A28" strokeDasharray="4 4" />
        <XAxis type="number" stroke="#8B8780" fontSize={11} tickFormatter={(v) => formatShort(Number(v))} />
        <YAxis
          type="category"
          dataKey="projectPath"
          stroke="#C8C5BD"
          fontSize={11}
          width={150}
          tickFormatter={(v: string) => short(v)}
        />
        <Tooltip
          contentStyle={{ background: "#1B1B1A", border: "1px solid #3A3A37", borderRadius: 8 }}
          formatter={(value, key) => {
            if (key === "tokens") return [formatShort(Number(value)), "Tokeny"];
            return [String(value), String(key)];
          }}
        />
        <Bar
          dataKey="tokens"
          radius={[4, 4, 4, 4]}
          onClick={(data) => {
            const projectPath = (data as { projectPath?: string }).projectPath ?? "";
            onSelect(projectPath === "(nepřiřazené)" ? "" : projectPath);
          }}
        >
          {series.map((entry) => (
            <Cell key={entry.projectPath} fill="#F26B3D" cursor="pointer" />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function short(value: string): string {
  if (value.length <= 28) return value;
  return `…${value.slice(-26)}`;
}

function formatShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
