"use client";

import { useMemo, useState } from "react";
import type { TelemetryUserAggregate } from "@claude-hub/schema";

interface PerUserTableProps {
  rows: TelemetryUserAggregate[];
  onSelect: (userId: string) => void;
}

type SortKey = "userEmail" | "sessions" | "tokens" | "costUsd" | "activeSeconds" | "lastSeenAt";

export function PerUserTable({ rows, onSelect }: PerUserTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("costUsd");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const valueA = sortValue(a, sortKey);
      const valueB = sortValue(b, sortKey);
      const cmp = typeof valueA === "string" && typeof valueB === "string"
        ? valueA.localeCompare(valueB)
        : Number(valueA) - Number(valueB);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  if (rows.length === 0) {
    return <p className="analytics-empty">Žádní členové týmu s telemetry.</p>;
  }

  return (
    <table className="analytics-table">
      <thead>
        <tr>
          <Th label="Uživatel" active={sortKey === "userEmail"} dir={sortDir} onClick={() => toggleSort("userEmail")} />
          <Th label="Sessions" active={sortKey === "sessions"} dir={sortDir} onClick={() => toggleSort("sessions")} />
          <Th label="Tokeny" active={sortKey === "tokens"} dir={sortDir} onClick={() => toggleSort("tokens")} />
          <Th label="Cena USD" active={sortKey === "costUsd"} dir={sortDir} onClick={() => toggleSort("costUsd")} />
          <Th label="Aktivní hodiny" active={sortKey === "activeSeconds"} dir={sortDir} onClick={() => toggleSort("activeSeconds")} />
          <Th label="Naposledy" active={sortKey === "lastSeenAt"} dir={sortDir} onClick={() => toggleSort("lastSeenAt")} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => {
          const tokens = row.tokensInput + row.tokensOutput + row.tokensCacheRead + row.tokensCacheCreate;
          return (
            <tr key={row.userId} onClick={() => onSelect(row.userId)} className="analytics-table-row">
              <td>{row.userEmail}</td>
              <td>{row.sessions.toLocaleString("cs-CZ")}</td>
              <td>{tokens.toLocaleString("cs-CZ")}</td>
              <td>{row.costUsd.toLocaleString("cs-CZ", { style: "currency", currency: "USD", maximumFractionDigits: 2 })}</td>
              <td>{(row.activeSeconds / 3600).toFixed(1)} h</td>
              <td>{row.lastSeenAt ? formatRelative(row.lastSeenAt) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Th({
  label,
  active,
  dir,
  onClick
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th onClick={onClick} className={active ? "is-active" : ""}>
      {label}
      {active ? <span className="analytics-th-arrow">{dir === "asc" ? "▲" : "▼"}</span> : null}
    </th>
  );
}

function sortValue(row: TelemetryUserAggregate, key: SortKey): string | number {
  switch (key) {
    case "userEmail":
      return row.userEmail;
    case "sessions":
      return row.sessions;
    case "tokens":
      return row.tokensInput + row.tokensOutput + row.tokensCacheRead + row.tokensCacheCreate;
    case "costUsd":
      return row.costUsd;
    case "activeSeconds":
      return row.activeSeconds;
    case "lastSeenAt":
      return row.lastSeenAt ?? "";
  }
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return iso;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "před chvílí";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} d`;
}
