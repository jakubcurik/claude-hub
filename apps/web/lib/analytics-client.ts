import type {
  TelemetryComparison,
  TelemetryOverview,
  TelemetryProjectsListItem,
  TelemetryUserSettingRow
} from "@claude-hub/schema";
import { hubFetch } from "./hub-auth";

export interface AnalyticsRange {
  from: string;
  to: string;
  projectPath?: string;
  userId?: string;
}

export async function fetchAnalyticsOverview(range: AnalyticsRange): Promise<TelemetryOverview> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  if (range.projectPath) params.set("projectPath", range.projectPath);
  if (range.userId) params.set("userId", range.userId);
  return hubFetch<TelemetryOverview>(`/v1/analytics/overview?${params.toString()}`);
}

export async function fetchAnalyticsComparison(
  rangeA: AnalyticsRange,
  rangeB: AnalyticsRange
): Promise<TelemetryComparison> {
  const params = new URLSearchParams({
    aFrom: rangeA.from,
    aTo: rangeA.to,
    bFrom: rangeB.from,
    bTo: rangeB.to
  });
  if (rangeA.projectPath) params.set("projectPath", rangeA.projectPath);
  if (rangeA.userId) params.set("userId", rangeA.userId);
  return hubFetch<TelemetryComparison>(`/v1/analytics/compare?${params.toString()}`);
}

export async function fetchAnalyticsProjects(): Promise<TelemetryProjectsListItem[]> {
  try {
    const { projects } = await hubFetch<{ projects: TelemetryProjectsListItem[] }>(
      "/v1/analytics/projects"
    );
    return projects;
  } catch {
    return [];
  }
}

export async function fetchAnalyticsUserSettings(): Promise<TelemetryUserSettingRow[]> {
  try {
    const { users } = await hubFetch<{ users: TelemetryUserSettingRow[] }>(
      "/v1/analytics/settings"
    );
    return users;
  } catch {
    return [];
  }
}

export async function setAnalyticsUserDisabled(userId: string, disabled: boolean) {
  await hubFetch<{ ok: true }>(`/v1/analytics/settings/${userId}`, {
    method: "PUT",
    jsonBody: { disabled }
  });
}
