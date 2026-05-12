export type AssetType = "skill" | "command" | "mcp" | "hook" | "plugin" | "config";

export type RiskLevel = "low" | "medium" | "high" | "restricted";

export type InstallState =
  | "not_installed"
  | "installed"
  | "enabled"
  | "disabled"
  | "update_available"
  | "local_changes"
  | "requires_setup"
  | "unsupported";

export interface AssetFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface AssetPermission {
  label: string;
  description: string;
  level: RiskLevel;
}

export interface CatalogAsset {
  id: string;
  type: AssetType;
  slug: string;
  name: string;
  summary: string;
  description: string;
  owner: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  version: string;
  risk: RiskLevel;
  tags: string[];
  usedBy: number;
  updatedAt: string;
  compatibility: {
    claudeCode?: string;
    daemon?: string;
    platforms: Array<"darwin" | "linux" | "windows">;
  };
  permissions: AssetPermission[];
  requiredEnv: string[];
  files: AssetFile[];
  contentHash?: string;
}

export interface PairedDevice {
  tokenHash: string;
  label: string;
  claudeHome: string;
  lastSeenAt: string;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  createdAt: string;
  createdBy: string;
}

export type TeamRole = "owner" | "admin" | "member";

export interface TeamMembership {
  teamId: string;
  userId: string;
  email: string;
  name: string;
  role: TeamRole;
  joinedAt: string;
}

export interface Collection {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  description: string;
  assetIds: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface SigningKey {
  id: string;
  userId: string;
  label: string;
  publicKey: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface AssetSignaturePayload {
  signature: string;
  publicKey: string;
}

export interface AssetDiffLine {
  type: "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface AssetFileDiff {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  lines: AssetDiffLine[];
}

export interface AssetDiff {
  assetId: string;
  files: AssetFileDiff[];
}

export interface CatalogAssetVersionRecord {
  version: string;
  publishedAt: string;
  publishedBy: string;
  asset: CatalogAsset;
}

export interface CatalogEventRecord {
  occurredAt: string;
  teamId: string;
  userId: string;
  event: string;
  assetId?: string;
  assetVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalAssetState {
  assetId: string;
  type: AssetType;
  slug: string;
  state: InstallState;
  installed: boolean;
  enabled: boolean;
  managedByHub: boolean;
  localVersion?: string;
  catalogVersion?: string;
  localChanges: boolean;
  updateAvailable: boolean;
  warnings: string[];
}

export interface InstallOperation {
  type: "create" | "replace" | "backup" | "manifest" | "enable" | "disable";
  path: string;
  description: string;
  risk: RiskLevel;
}

export interface InstallPreview {
  assetId: string;
  version: string;
  operations: InstallOperation[];
  warnings: string[];
  requiredEnv: string[];
}

export interface LocalAsset {
  localAssetId: string;
  type: AssetType;
  slug: string;
  name: string;
  path: string;
  scope: "user" | "project";
  projectName?: string;
  projectPath?: string;
  managedByHub: boolean;
  warnings: string[];
}

export interface LocalAssetExport {
  localAssetId: string;
  type: AssetType;
  slug: string;
  name: string;
  summary: string;
  description: string;
  version: string;
  risk: RiskLevel;
  warnings: string[];
  requiredEnv: string[];
  files: AssetFile[];
}

export interface DaemonHello {
  ok: boolean;
  app: "claude-hub-daemon";
  version: string;
  paired: boolean;
  tokenRequired: boolean;
  claudeHome: string;
  capabilities: string[];
}
