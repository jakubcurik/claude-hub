"use client";

import type { TelemetryBreakdownItem } from "@claude-hub/schema";

interface TopBreakdownProps {
  data: TelemetryBreakdownItem[];
  emptyLabel: string;
}

export function TopBreakdown({ data, emptyLabel }: TopBreakdownProps) {
  if (data.length === 0) {
    return <p className="analytics-empty">{emptyLabel}</p>;
  }
  const max = Math.max(...data.map((item) => item.value));
  return (
    <ol className="analytics-top-list">
      {data.map((item, index) => {
        const width = max > 0 ? Math.max(2, (item.value / max) * 100) : 0;
        return (
          <li key={`${item.key}-${index}`} className="analytics-top-item">
            <span className="analytics-top-rank">#{index + 1}</span>
            <span className="analytics-top-label" title={item.key}>{item.key}</span>
            <span className="analytics-top-bar">
              <span className="analytics-top-bar-fill" style={{ width: `${width}%` }} />
            </span>
            <span className="analytics-top-value">{item.value.toLocaleString("cs-CZ")}</span>
          </li>
        );
      })}
    </ol>
  );
}
