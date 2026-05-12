"use client";

import { useState, useTransition } from "react";
import type { TelemetryUserSettingRow } from "@claude-hub/schema";
import { toggleAnalyticsUserDisabled } from "@/app/actions";

interface OwnerSettingsProps {
  initialUsers: TelemetryUserSettingRow[];
}

export function OwnerSettings({ initialUsers }: OwnerSettingsProps) {
  const [users, setUsers] = useState(initialUsers);
  const [isPending, startTransition] = useTransition();
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  function toggle(userId: string, disabled: boolean) {
    setPendingUserId(userId);
    startTransition(async () => {
      await toggleAnalyticsUserDisabled(userId, disabled);
      setUsers((prev) =>
        prev.map((row) =>
          row.userId === userId
            ? {
                ...row,
                disabledByOwner: disabled,
                disabledAt: disabled ? new Date().toISOString() : undefined
              }
            : row
        )
      );
      setPendingUserId(null);
    });
  }

  if (users.length === 0) {
    return <p className="analytics-empty">V týmu zatím nejsou žádní členové.</p>;
  }

  return (
    <table className="analytics-table">
      <thead>
        <tr>
          <th>Uživatel</th>
          <th>Stav sběru</th>
          <th>Změněno</th>
          <th>Akce</th>
        </tr>
      </thead>
      <tbody>
        {users.map((row) => {
          const disabled = row.disabledByOwner;
          return (
            <tr key={row.userId}>
              <td>{row.userEmail}</td>
              <td>
                <span className={`analytics-status${disabled ? " is-off" : " is-on"}`}>
                  {disabled ? "Vypnuto" : "Aktivní"}
                </span>
              </td>
              <td>{disabled && row.disabledAt ? new Date(row.disabledAt).toLocaleString("cs-CZ") : "—"}</td>
              <td>
                <button
                  type="button"
                  className="analytics-action-button"
                  disabled={isPending && pendingUserId === row.userId}
                  onClick={() => toggle(row.userId, !disabled)}
                >
                  {disabled ? "Povolit" : "Vypnout"}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
