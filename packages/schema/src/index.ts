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

export type MarketplaceSource =
  | { source: "github"; repo: string; ref?: string; sha?: string }
  | { source: "url"; url: string; ref?: string; sha?: string }
  | {
      source: "git-subdir";
      url: string;
      path: string;
      ref?: string;
      sha?: string;
    }
  | {
      source: "npm";
      package: string;
      version?: string;
      registry?: string;
    };

export type PluginRecipeOptionValue = string | number | boolean;

export interface PluginRecipe {
  marketplaceName: string;
  marketplaceSource: MarketplaceSource;
  pluginName: string;
  defaultOptions?: Record<string, PluginRecipeOptionValue>;
  autoUpdate?: boolean;
  setupCommand?: string;
}

export const PLUGIN_RECIPE_FILE_PATH = "recipe.json";

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

export interface InstallOptions {
  scope?: "user" | "project";
  projectPath?: string;
}

export interface InstallScopeState {
  scope: "user" | "project";
  projectPath?: string;
  projectName?: string;
  installed: boolean;
  enabled: boolean;
  managedByHub: boolean;
  localVersion?: string;
  localChanges: boolean;
  updateAvailable: boolean;
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
  /** Stav instalace v každém scope (user + projekty), kde Hub našel manifest. */
  scopes?: InstallScopeState[];
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
  /** SHA-256 obsahu položky — slouží UI k seskupení identických kopií napříč projekty. */
  contentFingerprint?: string;
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

export interface KnownProject {
  path: string;
  name: string;
  claudeDirExists: boolean;
  accessible: boolean;
}

export interface DaemonHello {
  ok: boolean;
  app: "claude-hub-daemon";
  version: string;
  paired: boolean;
  tokenRequired: boolean;
  claudeHome: string;
  capabilities: string[];
  knownProjects?: KnownProject[];
}

// ────────────────────── Telemetry ──────────────────────

export interface TelemetryBufferMetric {
  name: string;
  value: number;
  timestampMs: number;
  attributes: Record<string, string>;
  resource: Record<string, string>;
}

export interface TelemetryBufferEvent {
  name: string;
  timestampMs: number;
  attributes: Record<string, string>;
  resource: Record<string, string>;
}

export type TelemetryBufferItem =
  | { kind: "metric"; metric: TelemetryBufferMetric }
  | { kind: "event"; event: TelemetryBufferEvent };

export interface TelemetryIngestRequest {
  items: TelemetryBufferItem[];
}

export interface TelemetryIngestResponse {
  accepted: number;
  dropped: number;
}

export interface TelemetryDaemonStatus {
  enabled: boolean;
  queueDepth: number;
  lastFlushAt?: string;
  lastError?: string;
}

export interface TelemetryDailyRow {
  day: string;
  userId: string;
  userEmail: string;
  projectPath: string;
  sessions: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreate: number;
  costUsd: number;
  activeSeconds: number;
}

export interface TelemetryTotals {
  sessions: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreate: number;
  costUsd: number;
  activeSeconds: number;
  cacheHitRatio: number;
}

export interface TelemetryFilters {
  from: string;
  to: string;
  projectPath?: string;
  userId?: string;
}

export interface TelemetryUserAggregate {
  userId: string;
  userEmail: string;
  sessions: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreate: number;
  costUsd: number;
  activeSeconds: number;
  lastSeenAt?: string;
}

export interface TelemetryProjectAggregate {
  projectPath: string;
  tokens: number;
  costUsd: number;
  sessions: number;
}

export interface TelemetryModelMixRow {
  userId: string;
  model: string;
  tokens: number;
}

export interface TelemetryBreakdownItem {
  key: string;
  value: number;
}

export interface TelemetryDailyTeamPoint {
  day: string;
  sessions: number;
  tokensTotal: number;
  costUsd: number;
}

export interface TelemetryCostPerDevPoint {
  day: string;
  cost: number;
  activeDevs: number;
}

export interface TelemetryOverview {
  filters: TelemetryFilters;
  totals: TelemetryTotals;
  dailyTeam: TelemetryDailyTeamPoint[];
  perUser: TelemetryUserAggregate[];
  perProject: TelemetryProjectAggregate[];
  modelMix: TelemetryModelMixRow[];
  topSkills: TelemetryBreakdownItem[];
  topPlugins: TelemetryBreakdownItem[];
  costPerDevPerDay: TelemetryCostPerDevPoint[];
}

export interface TelemetryComparison {
  periodA: TelemetryOverview;
  periodB: TelemetryOverview;
  delta: {
    sessionsPct: number;
    tokensPct: number;
    costUsdPct: number;
    activeSecondsPct: number;
  };
}

export interface TelemetryProjectsListItem {
  projectPath: string;
  lastSeenAt: string;
  uniqueUsers: number;
}

export interface TelemetryUserSettingRow {
  userId: string;
  userEmail: string;
  optedIn: boolean;
  disabledByOwner: boolean;
  optedInAt: string;
  disabledAt?: string;
}
