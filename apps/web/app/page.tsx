import { CatalogExperience } from "@/components/catalog-experience";
import { getTeam, listCollections, listSigningKeys, listTeamMembers } from "@/app/actions";
import { getCurrentUser, hubTeamId } from "@/lib/hub-auth";
import { getCatalogAssets } from "@/lib/registry-client";
import { redirect } from "next/navigation";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const teamId = hubTeamId();
  const teamSummary = await getTeam();

  if (!teamSummary) {
    // Uživatel přihlášený, ale není členem týmu (admin ho odebral).
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
            Účet <strong>{user.email}</strong> není členem týmu této instance Claude Hubu. Pokud to považujete za
            chybu, požádejte správce týmu o přidání.
          </p>
        </section>
      </main>
    );
  }

  const [assets, collections, members, signingKeys] = await Promise.all([
    getCatalogAssets(teamId),
    listCollections(),
    listTeamMembers(),
    listSigningKeys()
  ]);

  return (
    <CatalogExperience
      collections={collections}
      daemonInstall={{
        brewPackage: process.env.CLAUDE_HUB_DAEMON_BREW_PACKAGE ?? "animato-lab/tap/claude-hub-daemon",
        hubUrl: process.env.CLAUDE_HUB_PUBLIC_URL ?? "https://hub.animato-lab.cz",
        wingetId: process.env.CLAUDE_HUB_DAEMON_WINGET_ID ?? "Animato.ClaudeHubDaemon"
      }}
      initialAssets={assets}
      members={members}
      membership={teamSummary.membership}
      signingKeys={signingKeys}
      userEmail={user.email}
      userId={user.id}
    />
  );
}
