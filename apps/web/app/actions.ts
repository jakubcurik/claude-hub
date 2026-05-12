"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { CatalogAsset, LocalAssetExport, RiskLevel } from "@claude-hub/schema";
import { clearCurrentSession, getCurrentUser, getSessionToken, hubApiUrl, loginWithEmail } from "@/lib/hub-auth";

interface CatalogPublishResponse {
  asset: CatalogAsset;
}

export async function publishLocalAssetToCatalog(assetExport: LocalAssetExport): Promise<CatalogAsset> {
  const user = await getCurrentUser();
  const token = await getSessionToken();
  if (!user || !token) {
    throw new Error("Nejdřív se přihlaste, aby bylo možné nahrát položku do katalogu.");
  }

  const asset = toCatalogAsset(assetExport, user);
  const response = await fetch(`${hubApiUrl()}/v1/teams/${user.defaultTeamId}/catalog`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(asset)
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<CatalogPublishResponse> & {
    message?: string;
    error?: string;
  };

  if (!response.ok || !payload.asset) {
    throw new Error(payload.message || payload.error || "Položku se nepodařilo nahrát do katalogu.");
  }

  refresh();
  return payload.asset;
}

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  await loginWithEmail(email);
  redirect("/");
}

export async function logoutAction() {
  await clearCurrentSession();
  redirect("/login");
}

export async function registerPairedDevice(input: { tokenHash: string; label: string; claudeHome: string }) {
  const token = await getSessionToken();
  if (!token) {
    return;
  }

  await fetch(`${hubApiUrl()}/v1/devices/pairing`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(input)
  });
}

function toCatalogAsset(assetExport: LocalAssetExport, user: { id: string; email: string }): CatalogAsset {
  const now = new Date().toISOString();

  return {
    id: `${assetExport.type}:${assetExport.slug}`,
    type: assetExport.type,
    slug: assetExport.slug,
    name: assetExport.name,
    summary: assetExport.summary,
    description: assetExport.description,
    owner: {
      id: user.id,
      name: user.email
    },
    version: assetExport.version || "0.1.0",
    risk: assetExport.risk,
    tags: [assetExport.type],
    usedBy: 0,
    updatedAt: now,
    compatibility: {
      daemon: "0.1.0",
      platforms: ["darwin", "linux", "windows"]
    },
    permissions: [
      {
        label: riskLabel(assetExport.risk),
        description: "Položka pochází z lokální instalace Claude Code.",
        level: assetExport.risk
      }
    ],
    requiredEnv: assetExport.requiredEnv,
    files: assetExport.files
  };
}

function riskLabel(risk: RiskLevel) {
  switch (risk) {
    case "low":
      return "Nízké riziko";
    case "medium":
      return "Střední riziko";
    case "high":
      return "Vysoké riziko";
    case "restricted":
      return "Omezený přístup";
  }
}
