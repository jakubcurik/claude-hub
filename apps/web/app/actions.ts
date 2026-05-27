"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type {
  CatalogAsset,
  Collection,
  LocalAssetExport,
  RiskLevel,
  SigningKey,
  Team,
  TeamMembership,
  TelemetryComparison,
  TelemetryOverview,
  TelemetryProjectsListItem,
  TelemetryUserSettingRow
} from "@claude-hub/schema";
import {
  fetchAnalyticsComparison,
  fetchAnalyticsOverview,
  fetchAnalyticsProjects,
  fetchAnalyticsUserSettings,
  setAnalyticsUserDisabled,
  type AnalyticsRange
} from "@/lib/analytics-client";
import {
  clearCurrentSession,
  registerWithEmail,
  getCurrentUser,
  getSessionToken,
  hubApiUrl,
  hubFetch,
  hubTeamId,
  loginWithEmail
} from "@/lib/hub-auth";

interface CatalogPublishResponse {
  asset: CatalogAsset;
}

export async function publishLocalAssetToCatalog(
  assetExport: LocalAssetExport,
  overridesOrSignature?:
    | { name?: string; summary?: string }
    | { signature: string; publicKey: string },
  signature?: { signature: string; publicKey: string }
): Promise<CatalogAsset> {
  const user = await getCurrentUser();
  const token = await getSessionToken();
  if (!user || !token) {
    throw new Error("Nejdřív se přihlaste, aby bylo možné nahrát položku do katalogu.");
  }

  // Pozadu kompatibilní volání: druhý parametr může být signature (starý tvar) i overrides (nový).
  let overrides: { name?: string; summary?: string } | undefined;
  let sig: { signature: string; publicKey: string } | undefined;
  if (overridesOrSignature && "signature" in overridesOrSignature) {
    sig = overridesOrSignature;
  } else {
    overrides = overridesOrSignature;
    sig = signature;
  }

  const teamId = hubTeamId();
  const asset = toCatalogAsset(assetExport, user, overrides);

  const response = await fetch(`${hubApiUrl()}/v1/teams/${teamId}/catalog`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ asset, signature: sig })
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<CatalogPublishResponse> & {
    message?: string;
    error?: string;
  };

  if (!response.ok || !payload.asset) {
    throw new Error(payload.message || payload.error || "Položku se nepodařilo nahrát do katalogu.");
  }

  revalidatePath("/");
  return payload.asset;
}

/**
 * Publikuje plugin recipe (marketplace pointer) do katalogu. Na rozdíl od
 * publishLocalAssetToCatalog se nepoužívá export lokálního assetu — recipe
 * sestaví uživatel přes formulář (marketplace URL + plugin name).
 */
export async function publishPluginRecipe(input: {
  slug: string;
  name: string;
  summary: string;
  description?: string;
  version: string;
  risk: CatalogAsset["risk"];
  recipe: {
    marketplaceName: string;
    marketplaceSource: Record<string, unknown>;
    pluginName: string;
    defaultOptions?: Record<string, string | number | boolean>;
    autoUpdate?: boolean;
    setupCommand?: string;
  };
}): Promise<CatalogAsset> {
  const user = await getCurrentUser();
  const token = await getSessionToken();
  if (!user || !token) {
    throw new Error("Nejdřív se přihlaste, aby bylo možné nahrát plugin recipe do katalogu.");
  }
  const teamId = hubTeamId();

  const asset: CatalogAsset = {
    id: `plugin:${input.slug}`,
    type: "plugin",
    slug: input.slug,
    name: input.name,
    summary: input.summary,
    description: input.description || "",
    owner: { id: user.id, name: user.email },
    version: input.version,
    risk: input.risk,
    tags: ["plugin-recipe"],
    usedBy: 0,
    updatedAt: new Date().toISOString(),
    compatibility: {
      platforms: ["darwin", "linux", "windows"]
    },
    permissions: [],
    requiredEnv: [],
    files: [
      {
        path: "recipe.json",
        content: JSON.stringify(input.recipe, null, 2)
      }
    ]
  };

  const response = await fetch(`${hubApiUrl()}/v1/teams/${teamId}/catalog`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ asset })
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<CatalogPublishResponse> & {
    message?: string;
    error?: string;
  };

  if (!response.ok || !payload.asset) {
    throw new Error(payload.message || payload.error || "Plugin recipe se nepodařilo nahrát.");
  }

  revalidatePath("/");
  return payload.asset;
}

export interface AuthFormState {
  error?: string;
}

export async function loginAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    await loginWithEmail(email, password);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Přihlášení se nepodařilo." };
  }
  redirect("/");
}

export async function registerAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    await registerWithEmail(email, password);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Registrace se nezdařila." };
  }
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

export async function listPairedDevices() {
  const token = await getSessionToken();
  if (!token) {
    return [] as Array<{ tokenHash: string; label: string; claudeHome: string; lastSeenAt: string }>;
  }
  const response = await fetch(`${hubApiUrl()}/v1/devices`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    return [];
  }
  const payload = (await response.json()) as {
    devices: Array<{ tokenHash: string; label: string; claudeHome: string; lastSeenAt: string }>;
  };
  return payload.devices;
}

export async function revokePairedDevice(tokenHash: string) {
  const token = await getSessionToken();
  if (!token) {
    return;
  }
  await fetch(`${hubApiUrl()}/v1/devices/${encodeURIComponent(tokenHash)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  });
  revalidatePath("/");
}

export async function logCatalogEvent(input: {
  event: string;
  assetId?: string;
  assetVersion?: string;
  metadata?: Record<string, unknown>;
}) {
  const user = await getCurrentUser();
  const token = await getSessionToken();
  if (!user || !token) {
    return;
  }
  const teamId = hubTeamId();
  await fetch(`${hubApiUrl()}/v1/teams/${teamId}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(input)
  }).catch(() => undefined);
}

// ────────── Team (single tenant) ──────────

export async function getTeam(): Promise<{ team: Team; membership: TeamMembership } | null> {
  try {
    return await hubFetch<{ team: Team; membership: TeamMembership }>("/v1/team");
  } catch {
    return null;
  }
}

export async function listTeamMembers(): Promise<TeamMembership[]> {
  try {
    const { members } = await hubFetch<{ members: TeamMembership[] }>(`/v1/teams/${hubTeamId()}/members`);
    return members;
  } catch {
    return [];
  }
}

export async function removeTeamMember(userId: string) {
  await hubFetch<{ ok: true }>(`/v1/teams/${hubTeamId()}/members/${userId}`, {
    method: "DELETE"
  });
  revalidatePath("/");
}

export async function updateMemberRole(userId: string, role: "admin" | "member" | "owner") {
  await hubFetch<{ ok: true }>(`/v1/teams/${hubTeamId()}/members/${userId}`, {
    method: "PATCH",
    jsonBody: { role }
  });
  revalidatePath("/");
}

// ────────── Collections ──────────

export async function listCollections(): Promise<Collection[]> {
  try {
    const { collections } = await hubFetch<{ collections: Collection[] }>(
      `/v1/teams/${hubTeamId()}/collections`
    );
    return collections;
  } catch {
    return [];
  }
}

export async function saveCollection(input: {
  slug: string;
  name: string;
  description: string;
  assetIds: string[];
}): Promise<Collection> {
  const { collection } = await hubFetch<{ collection: Collection }>(
    `/v1/teams/${hubTeamId()}/collections`,
    { method: "PUT", jsonBody: input }
  );
  revalidatePath("/");
  return collection;
}

export async function deleteCollection(slug: string) {
  await hubFetch<{ ok: true }>(`/v1/teams/${hubTeamId()}/collections/${slug}`, {
    method: "DELETE"
  });
  revalidatePath("/");
}

// ────────── Signing keys ──────────

export async function listSigningKeys(): Promise<SigningKey[]> {
  try {
    const { keys } = await hubFetch<{ keys: SigningKey[] }>("/v1/signing-keys");
    return keys;
  } catch {
    return [];
  }
}

export async function registerSigningKey(input: {
  label: string;
  publicKey: string;
}): Promise<SigningKey> {
  const { key } = await hubFetch<{ key: SigningKey }>("/v1/signing-keys", {
    method: "POST",
    jsonBody: input
  });
  revalidatePath("/");
  return key;
}

export async function revokeSigningKey(keyId: string) {
  await hubFetch<{ ok: true }>(`/v1/signing-keys/${keyId}`, { method: "DELETE" });
  revalidatePath("/");
}

export async function generateAndRegisterSigningKey(label: string) {
  const { generateSigningKey } = await import("@/lib/signing");
  const generated = await generateSigningKey();
  const key = await registerSigningKey({ label, publicKey: generated.publicKeyBase64 });
  return {
    key,
    privateKeyPem: generated.privateKeyPem,
    publicKeyBase64: generated.publicKeyBase64,
    fingerprint: generated.fingerprint
  };
}

export async function publishWithSignature(
  assetExport: LocalAssetExport,
  privateKeyPem: string
): Promise<CatalogAsset> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Nejdřív se přihlaste.");
  }
  const { signAsset } = await import("@/lib/signing");
  const teamId = hubTeamId();
  const asset = {
    id: `${assetExport.type}:${assetExport.slug}`,
    type: assetExport.type,
    slug: assetExport.slug,
    name: assetExport.name,
    summary: assetExport.summary,
    description: assetExport.description,
    owner: { id: user.id, name: user.email },
    version: assetExport.version || "0.1.0",
    risk: assetExport.risk,
    tags: [assetExport.type],
    usedBy: 0,
    updatedAt: new Date().toISOString(),
    compatibility: {
      daemon: "0.1.0",
      platforms: ["darwin", "linux", "windows"] as Array<"darwin" | "linux" | "windows">
    },
    permissions: [
      { label: assetExport.risk, description: "Publikováno s podpisem.", level: assetExport.risk }
    ],
    requiredEnv: assetExport.requiredEnv,
    files: assetExport.files
  } satisfies CatalogAsset;

  const signature = await signAsset(privateKeyPem, asset);
  const token = await getSessionToken();
  if (!token) {
    throw new Error("Chybí session token.");
  }
  const response = await fetch(`${hubApiUrl()}/v1/teams/${teamId}/catalog`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ asset, signature })
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(payload.message || payload.error || "Podpis se nepodařilo nahrát do katalogu.");
  }
  const { asset: published } = (await response.json()) as { asset: CatalogAsset };
  revalidatePath("/");
  return published;
}

// ────────── Versions / rollback ──────────

export async function rollbackAssetVersion(type: string, slug: string, version: string) {
  await hubFetch<{ asset: CatalogAsset }>(
    `/v1/teams/${hubTeamId()}/catalog/${type}/${slug}/rollback`,
    { method: "POST", jsonBody: { version } }
  );
  revalidatePath("/");
}

export async function deleteCatalogAsset(type: string, slug: string) {
  await hubFetch<{ ok: true }>(`/v1/teams/${hubTeamId()}/catalog/${type}/${slug}`, {
    method: "DELETE"
  });
  revalidatePath("/");
}

export async function listAssetVersions(type: string, slug: string) {
  try {
    const { versions } = await hubFetch<{
      versions: Array<{ version: string; publishedAt: string; publishedBy: string; signature?: string }>;
    }>(`/v1/teams/${hubTeamId()}/catalog/${type}/${slug}/versions`);
    return versions;
  } catch {
    return [];
  }
}

function toCatalogAsset(
  assetExport: LocalAssetExport,
  user: { id: string; email: string },
  overrides?: { name?: string; summary?: string }
): CatalogAsset {
  const now = new Date().toISOString();
  const name = overrides?.name?.trim() || assetExport.name;
  const summary = overrides?.summary?.trim() ?? assetExport.summary;

  return {
    id: `${assetExport.type}:${assetExport.slug}`,
    type: assetExport.type,
    slug: assetExport.slug,
    name,
    summary,
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

// ────────── Analytics ──────────

export async function loadAnalyticsOverview(range: AnalyticsRange): Promise<TelemetryOverview> {
  return fetchAnalyticsOverview(range);
}

export async function loadAnalyticsComparison(
  rangeA: AnalyticsRange,
  rangeB: AnalyticsRange
): Promise<TelemetryComparison> {
  return fetchAnalyticsComparison(rangeA, rangeB);
}

export async function loadAnalyticsProjects(): Promise<TelemetryProjectsListItem[]> {
  return fetchAnalyticsProjects();
}

export async function loadAnalyticsUserSettings(): Promise<TelemetryUserSettingRow[]> {
  return fetchAnalyticsUserSettings();
}

export async function toggleAnalyticsUserDisabled(userId: string, disabled: boolean) {
  await setAnalyticsUserDisabled(userId, disabled);
  revalidatePath("/analytics/settings");
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
