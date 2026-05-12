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
