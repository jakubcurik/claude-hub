"use client";

import type { TelemetryComparison, TelemetryOverview } from "@claude-hub/schema";

interface KpiCardsProps {
  overview: TelemetryOverview;
  comparison: TelemetryComparison | null;
}

export function KpiCards({ overview, comparison }: KpiCardsProps) {
  const totals = overview.totals;
  const totalsB = comparison?.periodB.totals;

  const cards = [
    {
      label: "Sessions",
      value: formatInt(totals.sessions),
      previous: totalsB ? formatInt(totalsB.sessions) : null,
      deltaPct: comparison?.delta.sessionsPct ?? null
    },
    {
      label: "Tokeny celkem",
      value: formatInt(totals.tokensInput + totals.tokensOutput + totals.tokensCacheRead + totals.tokensCacheCreate),
      previous: totalsB
        ? formatInt(totalsB.tokensInput + totalsB.tokensOutput + totalsB.tokensCacheRead + totalsB.tokensCacheCreate)
        : null,
      deltaPct: comparison?.delta.tokensPct ?? null
    },
    {
      label: "Cena (USD)",
      value: formatCurrency(totals.costUsd),
      previous: totalsB ? formatCurrency(totalsB.costUsd) : null,
      deltaPct: comparison?.delta.costUsdPct ?? null
    },
    {
      label: "Aktivní hodiny",
      value: formatHours(totals.activeSeconds),
      previous: totalsB ? formatHours(totalsB.activeSeconds) : null,
      deltaPct: comparison?.delta.activeSecondsPct ?? null
    },
    {
      label: "Cache hit ratio",
      value: formatPercent(totals.cacheHitRatio),
      previous: totalsB ? formatPercent(totalsB.cacheHitRatio) : null,
      deltaPct: null
    }
  ];

  return (
    <div className="analytics-kpi-row">
      {cards.map((card) => (
        <article key={card.label} className="analytics-kpi-card">
          <span className="analytics-kpi-label">{card.label}</span>
          <strong className="analytics-kpi-value">{card.value}</strong>
          {card.previous ? (
            <span className="analytics-kpi-previous">
              vs {card.previous}
              {card.deltaPct !== null ? (
                <DeltaBadge value={card.deltaPct} />
              ) : null}
            </span>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function DeltaBadge({ value }: { value: number }) {
  if (!Number.isFinite(value)) return null;
  const positive = value >= 0;
  const symbol = positive ? "▲" : "▼";
  const formatted = `${symbol} ${Math.abs(value).toFixed(1)} %`;
  return (
    <span className={`analytics-kpi-delta${positive ? " is-up" : " is-down"}`}>
      {formatted}
    </span>
  );
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("cs-CZ");
}

function formatCurrency(value: number): string {
  return value.toLocaleString("cs-CZ", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  return `${hours.toFixed(1)} h`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}
