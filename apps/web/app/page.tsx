import { CatalogExperience } from "@/components/catalog-experience";
import { getCurrentUser } from "@/lib/hub-auth";
import { getCatalogAssets } from "@/lib/registry-client";
import { redirect } from "next/navigation";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const assets = await getCatalogAssets(user.defaultTeamId);
  return (
    <CatalogExperience
      daemonInstall={{
        brewPackage: process.env.CLAUDE_HUB_DAEMON_BREW_PACKAGE ?? "animato-lab/tap/claude-hub-daemon",
        hubUrl: process.env.CLAUDE_HUB_PUBLIC_URL ?? "https://hub.animato-lab.cz",
        wingetId: process.env.CLAUDE_HUB_DAEMON_WINGET_ID ?? "Animato.ClaudeHubDaemon"
      }}
      initialAssets={assets}
      userEmail={user.email}
    />
  );
}
