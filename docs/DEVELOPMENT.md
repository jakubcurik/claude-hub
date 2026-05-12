# Vývojářský průvodce

Praktické tipy pro lokální vývoj, debugging a běžné scénáře.

## Požadavky

- Node.js ≥ 22 (`engines` v root `package.json`)
- npm ≥ 10
- Go 1.26
- Docker Desktop (pro plný stack s Postgresem)
- Postgres 16 (pokud běží mimo Docker)

## Klonování a první instalace

```bash
git clone https://github.com/animato-lab/claude-hub.git
cd claude-hub
npm install
```

`npm install` nainstaluje závislosti všech workspaců (`apps/web`, `apps/api`, `packages/schema`). Daemon je samostatný Go modul — `go mod download` se spustí implicitně při prvním `go run` / `go build`.

## Lokální Postgres

Nejjednodušší cesta — pouze Postgres v Dockeru, zbytek nativně:

```bash
docker compose up postgres
```

Connection string:

```
postgres://claude_hub:claude_hub@127.0.0.1:5432/claude_hub
```

Po spuštění API se schéma vytvoří automaticky (`RegistryRepository.init()`).

## Tři terminály pro dev

```bash
# Terminal 1 — API
set CLAUDE_HUB_DATABASE_URL=postgres://claude_hub:claude_hub@127.0.0.1:5432/claude_hub
npm run dev:api

# Terminal 2 — Web
set CLAUDE_HUB_API_URL=http://127.0.0.1:8787
npm run dev:web

# Terminal 3 — Daemon
npm run dev:daemon
```

Daemon do logu vypíše párovací token. Příklad výpisu:

```
time=2026-05-12T17:30:00Z level=INFO msg="Claude Hub daemon listening" address=http://127.0.0.1:17373
time=2026-05-12T17:30:00Z level=INFO msg="Claude home" path=/home/kuba/.claude
time=2026-05-12T17:30:00Z level=INFO msg="Pairing token" token=AbCdEf...
time=2026-05-12T17:30:00Z level=INFO msg="Token file" path=/home/kuba/.claude/.claude-hub/daemon-token
```

## Typické workflow

### 1. Přidat nový seed asset

`apps/api/src/seed-assets.ts` exportuje pole `CatalogAsset[]`. Při startu API se vloží do `demo-team` s `overwrite: false`. Příklad:

```ts
export const seedAssets: CatalogAsset[] = [
  {
    id: "skill:review-skill",
    type: "skill",
    slug: "review-skill",
    name: "Review Skill",
    summary: "...",
    description: "...",
    owner: { id: "demo", name: "Demo tým" },
    version: "1.0.0",
    risk: "low",
    tags: ["review"],
    usedBy: 0,
    updatedAt: new Date().toISOString(),
    compatibility: { daemon: "0.1.0", platforms: ["darwin", "linux", "windows"] },
    permissions: [{ label: "Nízké riziko", description: "...", level: "low" }],
    requiredEnv: [],
    files: [{ path: "SKILL.md", content: "# Review Skill\n\n..." }]
  }
];
```

### 2. Otestovat instalaci na izolovaném `claudeHome`

Daemon přijímá `-claude-home` jako flag — ideální pro testy bez rizika přepsání reálné konfigurace:

```bash
go run ./apps/daemon/cmd/claude-hub-daemon -claude-home /tmp/fake-claude
```

V `/tmp/fake-claude/.claude-hub/daemon-token` bude vygenerovaný token.

### 3. Lokální projekt jako workspace root

Pokud chcete, aby daemon viděl projektové `.claude/`:

```bash
# Linux/macOS
export CLAUDE_HUB_WORKSPACE_ROOTS="$HOME/Projects:$HOME/Work"

# Windows PowerShell
$env:CLAUDE_HUB_WORKSPACE_ROOTS = "D:\Claude;C:\Work"

npm run dev:daemon
```

V UI v záložce **Tento počítač** se objeví projektové skilly, příkazy, hooky a MCP konfigurace.

### 4. Publikování lokální položky

1. V UI přepnout na **Tento počítač** → vidíte své lokální assety.
2. Klik na **Nahrát do katalogu** → daemon vyexportuje soubory, ukáže preview.
3. Po potvrzení server action `publishLocalAssetToCatalog` pošle do API.
4. Pak v záložce **Katalog** vidíte vlastní položku se statusem **Zapnuto**.

## Debugging

### Web

```bash
# Next.js dev server s detailním logem
DEBUG=* npm run dev:web
```

V prohlížeči je užitečné mít Network panel — všechny daemon volání mají `Authorization: Bearer …`, takže rychle uvidíte, jestli token sedí.

### API

Fastify logger píše na stdout (JSON). Pro pretty výpis:

```bash
npm --workspace @claude-hub/api run dev | npx pino-pretty
```

### Daemon

`slog.NewTextHandler` produkuje key=value formát. Můžete úroveň zvýšit přidáním `slog.HandlerOptions{Level: slog.LevelDebug}` v `main.go`, ale daemon zatím debug logy aktivně nevypisuje.

### Postgres

```bash
docker compose exec postgres psql -U claude_hub -d claude_hub
```

Užitečné dotazy:

```sql
-- aktivní sessions
SELECT user_id, expires_at FROM hub_sessions ORDER BY expires_at DESC;

-- katalog
SELECT team_id, type, slug, asset->>'version' AS version, updated_at
FROM catalog_assets ORDER BY updated_at DESC;

-- spárovaná zařízení
SELECT user_id, label, claude_home, last_seen_at FROM paired_devices;
```

## Reset prostředí

```bash
# Smaž všechno
npm run docker:down -v   # včetně volume Postgresu

# Smaž daemon stav
rm -rf ~/.claude/.claude-hub
```

⚠️ Smazání `~/.claude/.claude-hub` ztratí všechny zálohy a manifesty. Skilly/příkazy zapsané do `~/.claude/skills/…` a `~/.claude/commands/…` zůstanou.

## Testy

```bash
npm run typecheck                # tsc napříč workspacy
npm test                         # node test + go test
npm run test:daemon              # jen Go
```

### Spuštění Postgres integračního testu

```bash
set CLAUDE_HUB_TEST_DATABASE_URL=postgres://claude_hub:claude_hub@127.0.0.1:5432/claude_hub
npm --workspace @claude-hub/api test
```

Test vytvoří dočasný `team_id` (`test-<uuid>`) a po sobě uklízí.

## Časté problémy

| Symptom                                                                         | Příčina / Řešení                                                                  |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Web: „Claude Hub API není nastavené. Doplňte CLAUDE_HUB_API_URL."               | Chybí env proměnná. Před `npm run dev:web` nastavte `CLAUDE_HUB_API_URL`.         |
| API: „Chybí CLAUDE_HUB_DATABASE_URL."                                          | Před `npm run dev:api` nastavte connection string.                                |
| Daemon hlásí „Cesta k souboru není bezpečná"                                    | `CatalogAsset.files[].path` obsahuje absolutní cestu nebo `..`. Opravte slug/path. |
| UI: „Lokální služba neodpověděla včas."                                         | Daemon je vypnutý nebo blokovaný firewallem. Zkontrolujte `curl http://127.0.0.1:17373/v1/hello`. |
| UI: „Položka už v Claude Code existuje, ale nepochází z instalace přes Claude Hub." | Daemon detekoval lokální soubor, ke kterému nemá manifest. Buď přepište instalací, nebo nechte v ručním režimu. |
| Daemon: „lokální soubor už neexistuje"                                          | Uživatel ručně smazal nainstalovanou položku. Manifest v `.claude-hub/installed/` zůstal — daemon to hlásí jako warning. |
| API odpovídá 401 i s tokenem                                                    | Session token expiroval (30 dní). Stačí nový login.                               |

## Code style

- TypeScript ESM (`type: module` všude).
- Žádný runtime polyfill — cílíme na Node ≥ 22, browser ≥ moderní (React 19).
- Go: standardní `gofmt`, error handling stylem „if err != nil { return … }".
- Komentáře jen kde je důvod neobvyklý — preferujeme samodokumentující jména a typy.

## Užitečné odkazy

- [Claude Code dokumentace](https://docs.claude.com/en/docs/claude-code/overview)
- [Fastify schema validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Next.js App Router](https://nextjs.org/docs/app)
- [Go net/http](https://pkg.go.dev/net/http)
