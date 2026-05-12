import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/hub-auth";
import { getTeam, loadAnalyticsOverview, loadAnalyticsProjects } from "@/app/actions";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { DaemonProvider } from "@/lib/daemon-context";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const teamSummary = await getTeam();
  if (!teamSummary) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-block">
            <div className="brand-mark">CH</div>
            <div>
              <strong>Claude Hub · Analytika</strong>
              <span>Bez přístupu</span>
            </div>
          </div>
          <p>
            Účet <strong>{user.email}</strong> není členem žádného týmu, takže nemá k analytice
            přístup. Požádejte vlastníka týmu o přidání.
          </p>
        </section>
      </main>
    );
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const initialRange = {
    from: thirtyDaysAgo.toISOString(),
    to: now.toISOString()
  };
  const [initialOverview, projects] = await Promise.all([
    loadAnalyticsOverview(initialRange),
    loadAnalyticsProjects()
  ]);

  const telemetryApiEndpoint =
    process.env.CLAUDE_HUB_PUBLIC_API_URL ?? process.env.CLAUDE_HUB_API_URL ?? "";

  return (
    <DaemonProvider telemetryApiEndpoint={telemetryApiEndpoint}>
      <AnalyticsView
        userEmail={user.email}
        userId={user.id}
        teamName={teamSummary.team.name}
        initialOverview={initialOverview}
        projects={projects}
        initialRange={initialRange}
      />
    </DaemonProvider>
  );
}
