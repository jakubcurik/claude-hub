import { redirect } from "next/navigation";
import { CatalogExperience } from "@/components/catalog-experience";
import {
  getTeam,
  listCollections,
  listSigningKeys,
  listTeamMembers,
  loadAnalyticsUserSettings
} from "@/app/actions";
import { getCurrentUser, hubTeamId } from "@/lib/hub-auth";
import { getCatalogAssets } from "@/lib/registry-client";
import { DaemonProvider } from "@/lib/daemon-context";
import type { SidebarView } from "@/components/app-sidebar";

const VALID_VIEWS: SidebarView[] = ["catalog", "local", "collections", "team", "keys"];

export default async function Page({
  searchParams
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const teamId = hubTeamId();
  const teamSummary = await getTeam();

  if (!teamSummary) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-block">
            <div className="brand-mark">CH</div>
            <div>
              <strong>Claude Hub</strong>
              <span>Bez přístupu</span>
            </div>
          </div>
          <p>
            Účet <strong>{user.email}</strong> není členem týmu této instance Claude Hubu. Pokud to
            považujete za chybu, požádejte správce týmu o přidání.
          </p>
        </section>
      </main>
    );
  }

  const isOwner = teamSummary.membership.role === "owner";

  const [assets, collections, members, signingKeys, telemetrySettings] = await Promise.all([
    getCatalogAssets(teamId),
    listCollections(),
    listTeamMembers(),
    listSigningKeys(),
    isOwner ? loadAnalyticsUserSettings() : Promise.resolve(undefined)
  ]);

  // Daemon volá Claude Hub API přímo (server-to-server) bez prohlížeče, takže
  // potřebuje skutečně dostupnou URL — primárně CLAUDE_HUB_PUBLIC_API_URL,
  // fallback na CLAUDE_HUB_API_URL (lokální deploy).
  const telemetryApiEndpoint =
    process.env.CLAUDE_HUB_PUBLIC_API_URL ?? process.env.CLAUDE_HUB_API_URL ?? "";

  const params = await searchParams;
  const rawView = params?.view;
  const initialView = VALID_VIEWS.includes(rawView as SidebarView)
    ? (rawView as SidebarView)
    : undefined;

  return (
    <DaemonProvider telemetryApiEndpoint={telemetryApiEndpoint}>
      <CatalogExperience
        collections={collections}
        daemonInstall={{
          hubUrl: process.env.CLAUDE_HUB_PUBLIC_URL ?? "https://hub.animato-lab.cz"
        }}
        initialAssets={assets}
        members={members}
        membership={teamSummary.membership}
        signingKeys={signingKeys}
        userEmail={user.email}
        userId={user.id}
        teamName={teamSummary.team.name}
        initialView={initialView}
        telemetrySettings={telemetrySettings}
      />
    </DaemonProvider>
  );
}
