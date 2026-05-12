"use client";

import type {
  TelemetryOverview,
  TelemetryProjectsListItem
} from "@claude-hub/schema";
import { AppSidebar, type SidebarNavItem } from "@/components/app-sidebar";
import { AnalyticsDashboard } from "@/components/analytics/dashboard";
import type { AnalyticsRange } from "@/lib/analytics-client";

interface AnalyticsViewProps {
  userEmail: string;
  userId: string;
  teamName: string;
  initialOverview: TelemetryOverview;
  projects: TelemetryProjectsListItem[];
  initialRange: AnalyticsRange;
}

const navItems: SidebarNavItem[] = [
  { id: "catalog", label: "Katalog" },
  { id: "local", label: "Tento počítač" },
  { id: "collections", label: "Sady" },
  { id: "team", label: "Tým" },
  { id: "keys", label: "Klíče" }
];

export function AnalyticsView({
  userEmail,
  userId,
  teamName,
  initialOverview,
  projects,
  initialRange
}: AnalyticsViewProps) {
  return (
    <div className="shell">
      <AppSidebar
        userEmail={userEmail}
        teamName={teamName}
        navItems={navItems}
        mode={{ type: "external" }}
        analyticsActive
      />
      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">Telemetrie týmu</p>
            <h1>Analytika</h1>
          </div>
        </header>
        <AnalyticsDashboard
          initialOverview={initialOverview}
          projects={projects}
          currentUserId={userId}
          initialRange={initialRange}
        />
      </main>
    </div>
  );
}
