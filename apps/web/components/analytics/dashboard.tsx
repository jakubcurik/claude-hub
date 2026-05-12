"use client";

import { useMemo, useState, useTransition } from "react";
import type {
  TelemetryComparison,
  TelemetryOverview,
  TelemetryProjectsListItem
} from "@claude-hub/schema";
import {
  loadAnalyticsComparison,
  loadAnalyticsOverview
} from "@/app/actions";
import type { AnalyticsRange } from "@/lib/analytics-client";
import { KpiCards } from "./kpi-cards";
import { TokensTimeseries } from "./tokens-timeseries";
import { CostPerDevChart } from "./cost-per-dev";
import { ModelMixChart } from "./model-mix";
import { TopBreakdown } from "./top-breakdown";
import { PerProjectChart } from "./per-project";
import { PerUserTable } from "./per-user-table";

interface DashboardProps {
  initialOverview: TelemetryOverview;
  projects: TelemetryProjectsListItem[];
  currentUserId: string;
  initialRange: AnalyticsRange;
}

const PRESETS: Array<{ key: string; label: string; days: number }> = [
  { key: "7", label: "7 dní", days: 7 },
  { key: "30", label: "30 dní", days: 30 },
  { key: "90", label: "90 dní", days: 90 },
  { key: "180", label: "180 dní", days: 180 },
  { key: "365", label: "365 dní", days: 365 }
];

export function AnalyticsDashboard({
  initialOverview,
  projects,
  currentUserId,
  initialRange
}: DashboardProps) {
  const [overview, setOverview] = useState<TelemetryOverview>(initialOverview);
  const [comparison, setComparison] = useState<TelemetryComparison | null>(null);
  const [range, setRange] = useState<AnalyticsRange>(initialRange);
  const [compareRange, setCompareRange] = useState<AnalyticsRange | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [userFilter, setUserFilter] = useState<string>("");
  const [scope, setScope] = useState<"team" | "me">("team");
  const [isPending, startTransition] = useTransition();

  const activeRange = useMemo<AnalyticsRange>(
    () => ({
      from: range.from,
      to: range.to,
      projectPath: projectFilter || undefined,
      userId: scope === "me" ? currentUserId : userFilter || undefined
    }),
    [range, projectFilter, userFilter, scope, currentUserId]
  );

  function applyRange(next: AnalyticsRange, nextCompare: AnalyticsRange | null) {
    startTransition(async () => {
      if (nextCompare) {
        const result = await loadAnalyticsComparison(next, nextCompare);
        setComparison(result);
        setOverview(result.periodA);
      } else {
        const result = await loadAnalyticsOverview(next);
        setComparison(null);
        setOverview(result);
      }
    });
  }

  function selectPreset(days: number) {
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const next: AnalyticsRange = {
      ...activeRange,
      from: from.toISOString(),
      to: now.toISOString()
    };
    setRange({ from: next.from, to: next.to });
    applyRange(next, compareRange);
  }

  function toggleCompare() {
    if (compareRange) {
      setCompareRange(null);
      applyRange(activeRange, null);
      return;
    }
    // Default: porovnej s předchozím obdobím stejné délky.
    const length = new Date(range.to).getTime() - new Date(range.from).getTime();
    const previousTo = new Date(new Date(range.from).getTime() - 1);
    const previousFrom = new Date(previousTo.getTime() - length);
    const next: AnalyticsRange = {
      from: previousFrom.toISOString(),
      to: previousTo.toISOString(),
      projectPath: projectFilter || undefined,
      userId: scope === "me" ? currentUserId : userFilter || undefined
    };
    setCompareRange(next);
    applyRange(activeRange, next);
  }

  function changeFilters(updates: Partial<{ project: string; userId: string; scope: "team" | "me" }>) {
    const nextProject = updates.project !== undefined ? updates.project : projectFilter;
    const nextScope = updates.scope ?? scope;
    const nextUserId = updates.userId !== undefined ? updates.userId : userFilter;
    setProjectFilter(nextProject);
    setUserFilter(nextUserId);
    setScope(nextScope);
    const next: AnalyticsRange = {
      from: range.from,
      to: range.to,
      projectPath: nextProject || undefined,
      userId: nextScope === "me" ? currentUserId : nextUserId || undefined
    };
    applyRange(next, compareRange);
  }

  const usersForFilter = useMemo(() => {
    return overview.perUser
      .filter((row) => row.userEmail)
      .map((row) => ({ id: row.userId, email: row.userEmail }));
  }, [overview]);

  const userEmailById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of overview.perUser) {
      if (row.userEmail) map.set(row.userId, row.userEmail);
    }
    return map;
  }, [overview.perUser]);

  return (
    <section className="analytics-content">
      <div className="analytics-toolbar">
        <div className="analytics-toolbar-group">
          <span className="analytics-toolbar-label">Scope</span>
          <div className="analytics-segmented">
            <button
              type="button"
              className={scope === "team" ? "is-active" : ""}
              onClick={() => changeFilters({ scope: "team" })}
            >
              Celý tým
            </button>
            <button
              type="button"
              className={scope === "me" ? "is-active" : ""}
              onClick={() => changeFilters({ scope: "me" })}
            >
              Jen já
            </button>
          </div>
        </div>
        <div className="analytics-toolbar-group">
          <span className="analytics-toolbar-label">Období</span>
          <div className="analytics-presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className="analytics-preset"
                onClick={() => selectPreset(preset.days)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <div className="analytics-toolbar-group">
          <span className="analytics-toolbar-label">Projekt</span>
          <select
            className="analytics-select"
            value={projectFilter}
            onChange={(event) => changeFilters({ project: event.target.value })}
          >
            <option value="">Všechny projekty</option>
            {projects.map((project) => (
              <option key={project.projectPath} value={project.projectPath}>
                {shortProjectPath(project.projectPath)}
              </option>
            ))}
          </select>
        </div>
        {scope === "team" ? (
          <div className="analytics-toolbar-group">
            <span className="analytics-toolbar-label">Uživatel</span>
            <select
              className="analytics-select"
              value={userFilter}
              onChange={(event) => changeFilters({ userId: event.target.value })}
            >
              <option value="">Celý tým</option>
              {usersForFilter.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.email}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="analytics-toolbar-group">
          <button
            type="button"
            className={`analytics-toggle-compare${comparison ? " is-active" : ""}`}
            onClick={toggleCompare}
          >
            {comparison ? "Porovnání ZAP" : "Porovnat období"}
          </button>
        </div>
        {isPending ? <span className="analytics-loading">Načítám…</span> : null}
      </div>

      <KpiCards overview={overview} comparison={comparison} />

      <div className="analytics-grid">
        <article className="analytics-card analytics-card-wide">
          <header>
            <h3>Tokeny v čase</h3>
            <p>Stacked podle typu (input / output / cache read / cache create).</p>
          </header>
          <TokensTimeseries data={overview.dailyTeam} />
        </article>
        <article className="analytics-card">
          <header>
            <h3>Cena na vývojáře / den</h3>
            <p>Průměrný denní spend per aktivní uživatel.</p>
          </header>
          <CostPerDevChart data={overview.costPerDevPerDay} />
        </article>
        <article className="analytics-card">
          <header>
            <h3>Model mix</h3>
            <p>Tokeny per uživatel × model.</p>
          </header>
          <ModelMixChart data={overview.modelMix} userEmailById={userEmailById} />
        </article>
        <article className="analytics-card">
          <header>
            <h3>Top projekty</h3>
            <p>Podle celkového počtu tokenů.</p>
          </header>
          <PerProjectChart
            data={overview.perProject}
            onSelect={(project) => changeFilters({ project })}
          />
        </article>
        <article className="analytics-card">
          <header>
            <h3>Top skills</h3>
            <p>Aktivace podle počtu spuštění.</p>
          </header>
          <TopBreakdown data={overview.topSkills} emptyLabel="Žádné aktivace skills." />
        </article>
        <article className="analytics-card">
          <header>
            <h3>Top pluginy</h3>
            <p>Načtení podle počtu session startů.</p>
          </header>
          <TopBreakdown data={overview.topPlugins} emptyLabel="Žádné aktivované pluginy." />
        </article>
      </div>

      <article className="analytics-card analytics-card-wide">
        <header>
          <h3>Uživatelé v týmu</h3>
          <p>Klikněte na řádek pro filtraci dat na jednoho uživatele.</p>
        </header>
        <PerUserTable
          rows={overview.perUser}
          onSelect={(userId) => changeFilters({ userId, scope: "team" })}
        />
      </article>
    </section>
  );
}

function shortProjectPath(path: string): string {
  if (!path) return "(nepřiřazené)";
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join("/")}`;
}
