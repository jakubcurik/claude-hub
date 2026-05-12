# Local daemon (`apps/daemon`)

Lokální Go služba, která zprostředkovává všechny filesystem operace nad `~/.claude`. Webová aplikace s ní mluví výhradně přes `http://127.0.0.1:17373` a `Authorization: Bearer <párovací token>`. Daemon nikdy nekomunikuje s registry API přímo.

## Build a spuštění

```bash
go run ./apps/daemon/cmd/claude-hub-daemon

# nebo lokální binárka
go build -o bin/claude-hub-daemon ./apps/daemon/cmd/claude-hub-daemon
./bin/claude-hub-daemon -host 127.0.0.1 -port 17373
```

V Dockeru se používá multi-stage build z `apps/daemon/Dockerfile`. Před buildem se vynucené spustí `go test ./apps/daemon/...`.

## Vstupy

| Flag / env                        | Výchozí                                             | Význam                                                                  |
| --------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `-host` / `CLAUDE_HUB_DAEMON_HOST` | `127.0.0.1`                                         | Bind adresa. Neměňte bez znalosti důsledků.                             |
| `-port` / `CLAUDE_HUB_DAEMON_PORT` | `17373`                                             | TCP port.                                                               |
| `-claude-home` / `CLAUDE_HOME`     | `~/.claude` (`%USERPROFILE%\.claude`)               | Cesta ke Claude Code home, kterou daemon spravuje.                      |
| `CLAUDE_HUB_WORKSPACE_ROOTS`       | —                                                   | PATH-style oddělené (`;` na Windows, `:` jinde) seznam adresářů, v nichž se hledají projektové `.claude` složky. |
| `CLAUDE_HUB_WORKSPACE_ROOT`        | —                                                   | Jediný fallback root, pokud `ROOTS` chybí.                              |
| `CLAUDE_HUB_ALLOWED_WEB_ORIGINS`   | —                                                   | Origins (např. `https://hub.animato-lab.cz`) povolené nad rámec localhostu. Odděluje se `,`, `;`, mezerou nebo novým řádkem. |

Při startu daemon:

1. Resolveuje `claudeHome` (flag → env → user home).
2. Vytvoří `~/.claude/.claude-hub/` (`HubHome`) pokud neexistuje.
3. Buď načte existující `daemon-token`, nebo vygeneruje nový (24 náhodných bajtů, base64url, mode `0600`).
4. Vypíše do logu hostname, claudeHome, token a cestu k tokenu.
5. Zaregistruje HTTP route a začne poslouchat. Graceful shutdown na `SIGINT/SIGTERM` (timeout 5 s).

## Autentizace a CORS

Middleware `withAuth` ověřuje, že request má `Authorization: Bearer <token>` přesně rovnou párovacímu tokenu. CORS implementuje vlastní logika v `applyCORS`:

- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: content-type, authorization`
- `Access-Control-Allow-Origin` vrací pouze pokud origin matchuje regex `^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$` nebo je explicitně v `CLAUDE_HUB_ALLOWED_WEB_ORIGINS`.
- Při `Access-Control-Request-Private-Network: true` vrací `Access-Control-Allow-Private-Network: true` (Chrome Private Network Access).

## Endpointy

### `GET /pair` (bez autentizace)

Stránka pro potvrzení párování. Vstup `?returnUrl=…` musí být absolutní URL s povoleným origin. Po kliknutí uživatel:

- buď pošle `postMessage` do `window.opener` s `{ source: "claude-hub-daemon", type: "pairing-token", token }`,
- nebo se přesměruje na `returnUrl#daemonToken=<token>`.

### `GET /v1/hello` (volitelná autentizace)

```json
{
  "ok": true,
  "app": "claude-hub-daemon",
  "version": "0.1.0",
  "paired": true,
  "tokenRequired": true,
  "claudeHome": "/home/kuba/.claude",
  "capabilities": [
    "catalog-state",
    "install-preview",
    "install",
    "uninstall",
    "enable-disable",
    "local-assets",
    "local-asset-export",
    "diff",
    "mcp-merge",
    "hook-merge",
    "plugin-install"
  ]
}
```

Hodnota `paired` reflektuje, zda v aktuálním requestu seděl Bearer token. Slouží UI pro odlišení „zařízení mám, ale není spárované" vs. „token sedí".

### `POST /v1/state`

**Request**

```json
{ "catalog": [ /* CatalogAsset[] */ ] }
```

**Response**

```json
{ "state": [ /* LocalAssetState[] */ ] }
```

Daemon pro každý katalog asset spočítá stav, případně přidá varování (osiřelý manifest, lokální duplicit, suspicious content).

### `POST /v1/install-preview`

```json
{ "asset": { /* CatalogAsset */ } }
```

Vrací `InstallPreview` s polem operací:

- `backup` — pokud existuje aktuální položka (zapnutá i vypnutá),
- `create` nebo `replace` — zápis souborů,
- `manifest` — uložení metadat do `.claude-hub/installed/<type>-<slug>.json`.

Varování (`warnings`) obsahují stejné texty jako u lokálního skenování (`textWarnings`): tajné klíče, osobní cesty.

### `POST /v1/install`

Provede instalaci v jedné transakci na úrovni filesystemu:

1. Zazálohuje existující stav (`.claude-hub/backups/<timestamp>-<type>-<slug>/`).
2. Smaže případnou „disabled" kopii.
3. Zapíše soubory přes `writeAssetFiles` (validuje `SafeRelativePath` u každého souboru).
4. Vypočítá `fingerprint` (sha256 celého JSONu assetu) a `contentFingerprint` (sha256 cílového souboru).
5. Uloží manifest s `enabled: true`, `installedAt: now`.
6. Vrátí čerstvý `LocalAssetState`.

Daemon nyní povoluje `type ∈ {skill, command, mcp, hook, plugin}`. Pro merge typy (MCP, hook) se neaktualizuje cílový soubor jako celek, ale jen příslušné sekce — daemon si v manifestu pamatuje, které klíče nebo indexy přidal.

### `POST /v1/uninstall`

```json
{ "asset": { /* CatalogAsset */ } }
```

Pro `skill`/`command` smaže zapnutou i vypnutou kopii a manifest. Pro `mcp`/`hook` vrátí pouze klíče/indexy, které daemon přidal (zbytek `.mcp.json` / `settings.json` zachová). Pro `plugin` smaže `~/.claude/plugins/<slug>/` a aktualizuje `installed_plugins.json`.

### `POST /v1/diff`

```json
{ "asset": { /* CatalogAsset */ } }
```

Vrátí `AssetDiff` s `files[].lines[]` v `add`/`remove`/`context` značení. Implementováno pro skill a command přes LCS algoritmus. Pro MCP/hook vrací HTTP 400.

### `POST /v1/set-enabled`

```json
{ "asset": { /* CatalogAsset */ }, "enabled": false }
```

- `enabled: false` přesune soubory z `<skills/commands>/<slug>` do `.claude-hub/disabled/...`.
- `enabled: true` udělá opak.
- Manifest se aktualizuje (`enabled`, `updatedAt`).
- Pokud manifest dosud neexistoval, daemon ho vytvoří se stávajícím obsahem; tím zachytí i ručně zapnuté/vypnuté položky.

### `GET /v1/local-assets`

Sken `~/.claude` + projektových `.claude` v `CLAUDE_HUB_WORKSPACE_ROOTS`. Vrací:

```json
{
  "assets": [
    {
      "localAssetId": "skill:my-skill",
      "type": "skill",
      "slug": "my-skill",
      "name": "Moje skill",
      "path": "/home/kuba/.claude/skills/my-skill/SKILL.md",
      "scope": "user",
      "projectName": "",
      "projectPath": "",
      "managedByHub": true,
      "warnings": []
    }
  ]
}
```

`localAssetId` pro projektový asset má tvar `project:<projectSlug>:<type>:<slug>`, kde `projectSlug = Slugify(baseName(projectPath) + "-" + shortHash(projectPath))`. Tím se odliší projekty stejného jména.

### `POST /v1/local-assets/export`

```json
{ "localAssetId": "project:web-1a2b3c4d5e:skill:my-skill" }
```

Vrátí `LocalAssetExport` připravený k publikování do katalogu:

- pro **skill**: rekurzivně načte složku, vyloučí `.git`, `node_modules`, binární soubory, soubory > 512 KiB,
- pro **command**: jeden Markdown soubor (`<slug>.md`),
- pro **hook v `settings.json`**: vyexportuje pouze sekci `hooks` jako `settings.hooks.json`,
- pro **MCP**: jeden `.mcp.json`,
- ostatní: nejprve textový soubor, jinak adresářová struktura.

Soubory musí být validní UTF-8. Daemon shromáždí všechna varování z `textWarnings` a vrátí je v `warnings`.

## Datové struktury

Plný popis v [`types.go`](../apps/daemon/internal/claudecode/types.go):

```go
type CatalogAsset struct {
    ID, Slug, Name, Summary, Version string
    Type        AssetType   // skill | command | mcp | hook | plugin | config
    Risk        RiskLevel   // low | medium | high
    RequiredEnv []string
    Files       []AssetFile // { Path, Content, Executable }
}

type LocalAssetState struct {
    AssetID, Slug, LocalVersion, CatalogVersion string
    Type            AssetType
    State           string  // not_installed | enabled | disabled | local_changes | update_available | unsupported
    Installed       bool
    Enabled         bool
    ManagedByHub    bool
    LocalChanges    bool
    UpdateAvailable bool
    Warnings        []string
}
```

## Bezpečnostní kontroly

| Téma                  | Mechanismus                                                                |
| --------------------- | -------------------------------------------------------------------------- |
| Localhost only        | `flag -host` default `127.0.0.1`                                           |
| Token                 | Bearer auth, 24 bajtů, base64url, mode `0600`                              |
| CORS                  | regex `^https?://(localhost\|127\.0\.0\.1\|\[::1\])(:\d+)?$` + allowlist   |
| Path traversal        | `SafeRelativePath` zamítne absolutní a `..` segmenty                       |
| Velikost exportu      | `maxExportFileSize = 512 KiB`, jinak chyba „příliš velký pro sdílení"      |
| Binární soubory       | `shouldSkipExportFile` přeskakuje `.exe`, `.dll`, `.png`, `.zip`, …        |
| Tajné klíče v obsahu  | `secretLikePattern = (api_key\|token\|secret\|password)\s*[:=]`            |
| Osobní cesty          | `localPathPattern = (C:\\Users\\\|/users/\|/home/)`                        |
| Settings.json export  | Pouze sekce `hooks`, nikdy celé nastavení                                  |

## Testy

`apps/daemon/internal/claudecode/manager_test.go` pokrývá:

- `TestInstallSkillAndToggleState` — preview, install, disable, enable cyklus.
- `TestCatalogStateUsesRealFilesystemPresence` — když uživatel ručně smaže zapnutou skill, daemon to musí detekovat a vrátit warning „lokální soubor už neexistuje".
- `TestExportLocalCommand` — export uživatelského commandu, kontrola obsahu.

Spuštění:

```bash
go test ./apps/daemon/...
# nebo přes monorepo:
npm run test:daemon
```
