# Sdílené schéma (`packages/schema`)

Balíček `@claude-hub/schema` je single source of truth pro TypeScript typy webu i API. Daemon má vlastní ekvivalentní typy v Go (`apps/daemon/internal/claudecode/types.go`) — při změně sjednoťte oba zdroje.

## Build a použití

Balíček je publikovaný jako workspace s `type: module` a exportuje přímo zdrojový `src/index.ts` (TS, ne JS). Next.js si ho transpiluje díky `transpilePackages: ["@claude-hub/schema"]` v `apps/web/next.config.mjs`. API kompiluje do `dist/` přes `tsc`.

## Typy

### `AssetType`

```ts
type AssetType = "skill" | "command" | "mcp" | "hook" | "plugin" | "config";
```

Zatím podporuje daemon pouze `skill` a `command` pro full lifecycle (install/enable/disable). Ostatní typy umí detekovat a exportovat.

### `RiskLevel`

```ts
type RiskLevel = "low" | "medium" | "high" | "restricted";
```

| Hodnota      | Doporučené použití                                              |
| ------------ | --------------------------------------------------------------- |
| `low`        | Skilly, čistě textové prompty                                   |
| `medium`     | Slash příkazy, konfigurační soubory                             |
| `high`       | MCP servery, hooky, pluginy — vše, co spouští kód               |
| `restricted` | Položky s manuálně omezeným přístupem                           |

### `InstallState`

```ts
type InstallState =
  | "not_installed"
  | "installed"
  | "enabled"
  | "disabled"
  | "update_available"
  | "local_changes"
  | "requires_setup"
  | "unsupported";
```

Význam viz [`ARCHITECTURE.md`](ARCHITECTURE.md#stavový-model-assetu).

### `AssetFile`

```ts
interface AssetFile {
  path: string;        // relativní cesta (validuje SafeRelativePath)
  content: string;     // UTF-8 text
  executable?: boolean;
}
```

### `AssetPermission`

```ts
interface AssetPermission {
  label: string;
  description: string;
  level: RiskLevel;
}
```

### `CatalogAsset`

```ts
interface CatalogAsset {
  id: string;
  type: AssetType;
  slug: string;
  name: string;
  summary: string;
  description: string;
  owner: { id: string; name: string; avatarUrl?: string };
  version: string;
  risk: RiskLevel;
  tags: string[];
  usedBy: number;
  updatedAt: string;        // ISO 8601
  compatibility: {
    claudeCode?: string;
    daemon?: string;
    platforms: Array<"darwin" | "linux" | "windows">;
  };
  permissions: AssetPermission[];
  requiredEnv: string[];
  files: AssetFile[];
}
```

Toto je hlavní jednotka katalogu. Validuje se v API přes Fastify schéma engine (`assetBodySchema` v `apps/api/src/routes.ts`).

### `LocalAssetState`

```ts
interface LocalAssetState {
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
```

Vrací daemon z `POST /v1/state`, `POST /v1/install` a `POST /v1/set-enabled`.

### `InstallOperation` a `InstallPreview`

```ts
interface InstallOperation {
  type: "create" | "replace" | "backup" | "manifest" | "enable" | "disable";
  path: string;
  description: string;
  risk: RiskLevel;
}

interface InstallPreview {
  assetId: string;
  version: string;
  operations: InstallOperation[];
  warnings: string[];
  requiredEnv: string[];
}
```

Web UI mapuje `type` na české labely:

```ts
{
  create: "Vytvořit",
  replace: "Nahradit",
  backup: "Zálohovat",
  manifest: "Uložit metadata",
  enable: "Zapnout",
  disable: "Vypnout"
}
```

### `LocalAsset`

```ts
interface LocalAsset {
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
```

Vrací `GET /v1/local-assets`. `managedByHub` znamená, že daemon má k položce manifest v `.claude-hub/installed/`.

### `LocalAssetExport`

```ts
interface LocalAssetExport {
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
```

Návratová hodnota `POST /v1/local-assets/export`. Web ji v `app/actions.ts → toCatalogAsset()` přemění na plný `CatalogAsset` (doplní owner, tagy, kompatibilitu, permissions).

### `DaemonHello`

```ts
interface DaemonHello {
  ok: boolean;
  app: "claude-hub-daemon";
  version: string;
  paired: boolean;
  tokenRequired: boolean;
  claudeHome: string;
  capabilities: string[];
}
```

## JSON Schema

Soubor [`packages/schema/src/catalog.schema.json`](../packages/schema/src/catalog.schema.json) drží JSON Schema 2020-12 verzi `CatalogAsset` pro externí validátory. **TypeScript verze a JSON Schema musí být udržovány v synchronizaci.** Při změně typu prosím upravte obojí.

## Konvence pojmenování

- `id` má tvar `<type>:<slug>` (viz `app/actions.ts → toCatalogAsset`).
- `slug` musí matchovat regex `^[a-z0-9]+(?:-[a-z0-9]+)*$` (kebab-case, ASCII). Go `Slugify` provádí transliteraci českých znaků.
- `version` se očekává jako SemVer (`0.1.0`); daemon ji používá pro detekci `update_available`.
- `updatedAt` je ISO 8601 UTC string.
