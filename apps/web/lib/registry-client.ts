import type { CatalogAsset } from "@claude-hub/schema";
import { catalogAssets } from "@/lib/catalog";
import { getSessionToken, hubApiUrl } from "@/lib/hub-auth";

interface CatalogResponse {
  assets: CatalogAsset[];
}

export async function getCatalogAssets(teamId: string): Promise<CatalogAsset[]> {
  const token = await getSessionToken();
  if (!token) {
    return catalogAssets.map(normalizeCatalogCopy);
  }

  try {
    const response = await fetch(`${hubApiUrl()}/v1/teams/${teamId}/catalog`, {
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      return catalogAssets;
    }

    const payload = (await response.json()) as CatalogResponse;
    return payload.assets.map(normalizeCatalogCopy);
  } catch {
    return catalogAssets.map(normalizeCatalogCopy);
  }
}

function normalizeCatalogCopy(asset: CatalogAsset): CatalogAsset {
  return {
    ...asset,
    summary: normalizeGeneratedSummary(asset.summary),
    description: normalizeGeneratedDescription(asset.description),
    permissions: asset.permissions.map((permission) => ({
      ...permission,
      description:
        permission.description === "Položka byla nahrána z lokální instalace Claude Code."
          ? "Položka pochází z lokální instalace Claude Code."
          : permission.description
    }))
  };
}

function normalizeGeneratedSummary(summary: string) {
  if (summary === "Lokální položka nahraná z Claude Code.") {
    return "Položka nahraná z lokální instalace Claude Code.";
  }
  return summary;
}

function normalizeGeneratedDescription(description: string) {
  if (description === "Exportováno z uživatelské instalace Claude Code.") {
    return "Položka pochází z uživatelské instalace Claude Code.";
  }

  const projectMatch = /^Exportováno z projektu (.+)\.$/.exec(description);
  if (projectMatch) {
    return `Položka pochází z projektu ${projectMatch[1]}.`;
  }

  return description;
}
