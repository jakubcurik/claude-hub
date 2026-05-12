# Architektura Claude Hubu

Tento dokument popisuje celkový design aplikace, hranice odpovědnosti jednotlivých služeb, datové toky a klíčová bezpečnostní omezení. Pro produktové zadání viz [PRODUCT_PLAN.md](PRODUCT_PLAN.md), pro detaily HTTP rozhraní [API.md](API.md), [DAEMON.md](DAEMON.md) a [WEB.md](WEB.md).

## Přehled

Claude Hub se skládá ze čtyř souběžně běžících komponent:

| Komponenta        | Adresář             | Stack                                 | Role                                                           |
| ----------------- | ------------------- | ------------------------------------- | -------------------------------------------------------------- |
| Web aplikace      | `apps/web`          | Next.js 16 (App Router), React 19     | Hlavní rozhraní pro tým — katalog, lokální stav, publikování   |
| Registry API      | `apps/api`          | Fastify 5, TypeScript, node-postgres  | Persistence katalogu, autentizace, evidence spárovaných zařízení |
| Local daemon      | `apps/daemon`       | Go 1.26, stdlib `net/http`            | Čte a zapisuje `~/.claude`, vrací lokální stav položek         |
| Sdílené schéma    | `packages/schema`   | TypeScript + JSON Schema              | Společné typy mezi webem a API; kontrakt pro daemon            |

Databáze: Postgres 16 (z `compose.yaml`, případně vlastní instance). Daemon má vlastní lokální úložiště v `~/.claude/.claude-hub/` (token, manifesty, zálohy, vypnuté položky).

## Tok dat

```text
   Uživatel ─▶  Web (Next.js)
                ├─ server actions ──▶ Registry API ─▶ Postgres
                │   ▲                                  ▲
                │   │ Bearer session token            │
                │   └─ HTTP-only cookie               │
                │                                     │
                └─ klient (DaemonClient) ─────▶ Local daemon
                                                ├─ filesystem ~/.claude
                                                └─ workspace .claude/
```

1. **Přihlášení.** Web pošle e-mail na `POST /v1/auth/login`, dostane session token a uloží ho do HTTP-only cookie `claude_hub_session`. Server actions (`apps/web/app/actions.ts`) a `getCurrentUser` čtou token z cookies a posílají ho jako `Authorization: Bearer …` do API.
2. **Načtení katalogu.** `app/page.tsx` na serveru volá `getCatalogAssets` → `GET /v1/teams/:teamId/catalog`. Pokud uživatel není přihlášený nebo API selže, vrátí se prázdný/lokální fallback (`apps/web/lib/catalog.ts`).
3. **Spárování zařízení.** Uživatel v UI klikne **Spárovat**. Web ověří dostupnost daemonu (`GET /v1/hello`) a otevře `http://127.0.0.1:17373/pair?returnUrl=…`. Daemon vykreslí potvrzovací HTML stránku; po kliknutí pošle token přes `window.opener.postMessage` nebo přesměrováním na `/pair/complete#daemonToken=…`. Token web uloží do `localStorage` pod klíčem `claudeHubDaemonToken`.
4. **Lokální stav.** Klientský komponent `CatalogExperience` posílá katalog na `POST /v1/state`. Daemon vrátí pole `LocalAssetState` (instalován/zapnut/upraven/nová verze). Současně se volá `GET /v1/local-assets`, který sbírá uživatelské i projektové assety.
5. **Instalace.** `POST /v1/install-preview` vrátí seznam operací; uživatel je vidí v modálu. Po potvrzení se zavolá `POST /v1/install`, daemon zazálohuje existující data, zapíše soubory, uloží manifest a vrátí nový stav.
6. **Publikování.** `POST /v1/local-assets/export` zabalí lokální soubory do `LocalAssetExport`. Web tento payload pošle přes server action `publishLocalAssetToCatalog` do `POST /v1/teams/:teamId/catalog`, kde se uloží do Postgresu.

## Hraniční rozhodnutí

- **Web nikdy nesahá na disk.** Veškeré filesystem operace běží přes daemon. Tím se izoluje sandbox prohlížeče od `~/.claude`.
- **Daemon nikdy nemluví s registry API.** Kontrakt jde výhradně přes web — daemon zná pouze typy `CatalogAsset` a `LocalAsset` a nevyžaduje žádné credentialy k Hubu.
- **Postgres je single source of truth pro katalog.** Daemon má vlastní stav (manifesty), ale nikdy nereplikuje katalog do paměti — vždy dostává čerstvý seznam z webu.
- **Cookie `claude_hub_session` je HTTP-only**, takže klientský JavaScript ji nečte. Daemonský token žije v `localStorage` (vyžaduje access ke konkrétnímu prohlížeči).

## Datový model (Postgres)

Schéma vytváří `RegistryRepository.init()` v `apps/api/src/repository.ts` při startu API.

```sql
CREATE TABLE hub_users (
  id              text PRIMARY KEY,
  email           text NOT NULL UNIQUE,
  name            text NOT NULL,
  default_team_id text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hub_sessions (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE paired_devices (
  user_id      text NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  label        text NOT NULL,
  claude_home  text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token_hash)
);

CREATE TABLE catalog_assets (
  team_id    text NOT NULL,
  type       text NOT NULL,
  slug       text NOT NULL,
  asset      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, type, slug)
);
```

- `hub_users.id` se generuje deterministicky jako `user_<sha256(email).slice(0,24)>` — login je idempotentní.
- `hub_sessions.token_hash` je `sha256(sessionToken)`. Plain token žije pouze v cookie u klienta.
- `paired_devices.token_hash` je hash daemonského párovacího tokenu; API zná pouze hash a popisek (`hello.claudeHome`), nikdy plain token.
- `catalog_assets.asset` drží celý `CatalogAsset` jako JSONB. Tím se schéma katalogu vyvíjí bez migrace tabulky.

Při startu API se přes `seedAssets` (`apps/api/src/seed-assets.ts`) volá `upsertAsset` s `overwrite=false` — případné seed položky se vloží jen pokud ještě neexistují. V současné MVP fázi je seed prázdný.

## Stavový model assetu

`LocalAssetState.state` z daemonu může nabývat:

| Stav                 | Význam v UI                                         | Kdy daemon vrátí                                                |
| -------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `not_installed`      | „Nenainstalováno"                                   | Cílový soubor neexistuje a daemon nemá manifest                 |
| `enabled`            | „Zapnuto"                                           | Cílový soubor existuje, není upravený                           |
| `disabled`           | „Vypnuto"                                           | Soubor přesunutý do `.claude-hub/disabled/…`                    |
| `update_available`   | „Nová verze"                                        | Manifest má jinou `version`, než katalog                        |
| `local_changes`      | „Upraveno lokálně"                                  | `sha256(soubor)` neodpovídá `manifest.contentFingerprint`       |
| `unsupported`        | „Zatím jen v katalogu"                              | `asset.type ∉ {skill, command}` — daemon zatím neumí instalovat |
| `requires_setup`     | Nepoužívá se v aktuální verzi (rezervovaný)         | —                                                               |

`CatalogExperience.formatState` mapuje stav na vizuální „tone" (`enabled`, `warning`, `update`, `disabled`, `neutral`, `offline`, `planned`).

## Typy assetů

Definované v `packages/schema/src/index.ts` a `apps/daemon/internal/claudecode/types.go`:

| Typ       | Cíl uživatelské instalace                         | Cíl projektové detekce                            | Daemon instaluje? |
| --------- | ------------------------------------------------- | ------------------------------------------------- | ----------------- |
| `skill`   | `~/.claude/skills/<slug>/SKILL.md`                | `<project>/.claude/skills/<slug>/SKILL.md`        | ✅                |
| `command` | `~/.claude/commands/<slug>.md`                    | `<project>/.claude/commands/<slug>.md`            | ✅                |
| `hook`    | `~/.claude/hooks/*` a sekce `hooks` v `settings.json` | `<project>/.claude/hooks/*` + `settings.json` | jen export        |
| `mcp`     | `~/.claude/.mcp.json`                             | `<project>/.claude/.mcp.json`, `<project>/.mcp.json` | jen export        |
| `plugin`  | `~/.claude/plugins/installed_plugins.json`        | `<project>/.claude/plugins/*`                     | jen export        |
| `config`  | obecné konfigurační soubory                       | totéž                                             | zatím ne          |

Pro typy `mcp`, `hook`, `plugin`, `config` daemon vrací `state: "unsupported"` u `LocalAssetState` (instalovat zatím neumí), ale dokáže je **detekovat a exportovat**, aby je tým mohl ručně sdílet a uvidět v UI.

## Lokální úložiště daemonu

Daemon si pod `~/.claude/.claude-hub/` (`HubHome`) drží:

```text
.claude-hub/
├── daemon-token              # 24 bajtů náhodných dat, base64url, mode 0600
├── installed/                # manifesty per asset
│   ├── skill-<slug>.json
│   └── command-<slug>.json
├── disabled/                 # přesunuté vypnuté položky
│   ├── skills/<slug>/SKILL.md
│   └── commands/<slug>.md
└── backups/                  # časem orámované zálohy před přepsáním
    └── 20260512T173512Z-skill-<slug>/
        ├── enabled/SKILL.md  (pokud existovala zapnutá verze)
        ├── disabled/SKILL.md (pokud existovala vypnutá verze)
        └── manifest.json
```

`manifest.json` (`apps/daemon/internal/claudecode/types.go`):

```json
{
  "assetId": "skill:review-skill",
  "type": "skill",
  "slug": "review-skill",
  "name": "Review Skill",
  "version": "1.0.0",
  "enabled": true,
  "installedAt": "2026-05-12T17:00:00Z",
  "updatedAt": "2026-05-12T17:05:00Z",
  "fingerprint": "<sha256 celého CatalogAsset JSONu>",
  "contentFingerprint": "<sha256 obsahu cílového souboru>",
  "backupPath": "/home/uzivatel/.claude/.claude-hub/backups/20260512T170000Z-skill-review-skill"
}
```

`contentFingerprint` je klíčový pro detekci `local_changes`: po každé akci se ukládá hash zapsaného souboru, a `state` ho při dalším volání porovnává s aktuálním obsahem.

## Lokální skenování

`Manager.LocalAssets` v `apps/daemon/internal/claudecode/manager.go` skládá výsledek z těchto zdrojů:

1. `~/.claude/skills/*/SKILL.md` (`skillAssets`)
2. `~/.claude/commands/*.md` (`commandAssets`)
3. `~/.claude/hooks/*` (`entryAssets`)
4. Sekce `hooks` v `~/.claude/settings.json` (`settingsHookAsset`)
5. Pluginy z `~/.claude/plugins/installed_plugins.json` (`pluginAssets`)
6. MCP konfigurace v `~/.claude/.mcp.json` (`mcpAsset`)
7. Projektové ekvivalenty: každá složka `<root>/<…>/.claude/` v cestách z `CLAUDE_HUB_WORKSPACE_ROOTS`. Skenování ignoruje `node_modules`, `.git`, `.next`, `dist`, `build`, `vendor`.

Pro každý nalezený text se hledají **varování**:

- regex `(api[_-]?key|token|secret|password)\s*[:=]` → upozornění na tajný klíč
- regex `([a-z]:\\users\\|/users/|/home/)` → upozornění na osobní cesty

Tyto warninge se přilepí k položce a UI je zobrazí před publikováním do katalogu.

## Slug, ID a bezpečnost cest

`Slugify` (`apps/daemon/internal/claudecode/paths.go`) provádí transliteraci českých znaků (`á`→`a`, `č`→`c`, …), lowercase, redukci na `[a-z0-9-]+` a oříznutí na 72 znaků. To je důležité, protože slug se používá jako cesta v souborovém systému i jako klíč v Postgresu.

`SafeRelativePath` odmítne absolutní cesty a všechno, co obsahuje `..`. To je obrana proti path traversal útokům přes podvržený `CatalogAsset.files[].path`.

## Bezpečnostní kontrolní seznam

- Daemon povoluje pouze localhost origins + explicitně vyjmenované přes `CLAUDE_HUB_ALLOWED_WEB_ORIGINS`.
- `Authorization: Bearer <token>` u všech `/v1/*` kromě `/v1/hello` a `/pair`.
- `/pair` validuje `returnUrl` — musí být absolutní a mít povolený origin, jinak vrací HTTP 400.
- API vyžaduje session token u všech `/v1/teams/*` a `/v1/devices/*`.
- Session token žije 30 dní, hash v DB, plain v HTTP-only cookie.
- Sdílení tokenů, hesel a osobních cest se webové UI varovně ptá uživatele před publikem.
- Export pouze UTF-8 do 512 KiB; binární přípony (`.exe`, `.dll`, `.png`, `.zip`, …) se přeskakují.

## Rozšiřitelnost

Pro přidání nového typu assetu:

1. Doplňte konstantu do `AssetType` v `packages/schema/src/index.ts` a `apps/daemon/internal/claudecode/types.go`.
2. Rozšiřte `validateSupported` a `Manager.paths()` v daemonu o nový handler.
3. Přidejte vizuální label do `typeLabels` a `filters` v `apps/web/components/catalog-experience.tsx`.
4. Zaktualizujte JSON Schema v `packages/schema/src/catalog.schema.json` (enum).
5. Pokud jde o vyšší riziko (MCP/hook/plugin), zaveďte specifickou politiku rizika a preview operací.
