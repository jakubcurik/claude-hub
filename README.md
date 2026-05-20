# Claude Hub

Claude Hub je týmový katalog rozšíření pro [Claude Code](https://docs.claude.com/en/docs/claude-code/overview). Slouží ke sdílení skillů, slash příkazů, MCP serverů, hooků, pluginů a konfiguračních předvoleb mezi členy týmu — **bez vynucené synchronizace**. Každý uživatel sám volí, co si nainstaluje, zapne, vypne, aktualizuje nebo nahraje zpět do katalogu.

> Příslib produktu: jeden člověk publikuje užitečný asset, ostatní si ho najdou v přehledném českém webu, vidí, jestli ho už mají, a nainstalují ho jedním kliknutím — bez ručních návodů.

---

## Obsah

- [Klíčové vlastnosti](#klíčové-vlastnosti)
- [Architektura](#architektura)
- [Rychlý start](#rychlý-start)
- [Vývojové prostředí](#vývojové-prostředí)
- [Docker Desktop](#docker-desktop)
- [Konfigurace přes proměnné prostředí](#konfigurace-přes-proměnné-prostředí)
- [Verifikace a testy](#verifikace-a-testy)
- [Bezpečnostní model](#bezpečnostní-model)
- [Aktuální rozsah a roadmapa](#aktuální-rozsah-a-roadmapa)
- [Další dokumentace](#další-dokumentace)

---

## Klíčové vlastnosti

- **Český web katalog** postavený na Next.js 16 a React 19 — hlavní rozhraní pro tým.
- **Lokální Go služba (daemon)** běží na `127.0.0.1:17373` a jako jediná smí psát do `~/.claude`.
- **Postgres-backed registry API** (Fastify 5) drží metadata sdílených položek.
- **Preview před každým zápisem** — uživatel vidí, co se vytvoří, přepíše nebo zazálohuje, než to potvrdí.
- **Detekce lokálního stavu** — pro každou položku v katalogu se zobrazí, jestli ji uživatel má, jestli je zapnutá, vypnutá, upravená nebo má novější verzi.
- **Publikování z lokálu** — uživatel nahraje vlastní skill nebo příkaz přímo z `.claude/` do katalogu, s upozorněním na tokeny a osobní cesty.
- **Email-only přihlášení** s HTTP-only session cookie a hashovanou identifikací spárovaných zařízení.

## Architektura

```text
apps/web         Next.js katalog (UI, server actions, lokální stav)
apps/api         TypeScript/Fastify registry API nad Postgresem
apps/daemon      Go služba pro filesystem operace nad Claude Code
packages/schema  Sdílené TypeScript typy a JSON Schema
docs             Produktové a architektonické poznámky
```

```text
   ┌──────────────┐       HTTP(S)       ┌──────────────┐       SQL        ┌─────────┐
   │   Web app    │ ──────────────────▶ │ Registry API │ ───────────────▶ │Postgres │
   │  (Next.js)   │                     │  (Fastify)   │                  │         │
   └──────┬───────┘                     └──────────────┘                  └─────────┘
          │ Authorization: Bearer <pairing token>
          │ pouze 127.0.0.1
          ▼
   ┌──────────────┐    čte/zapisuje     ┌────────────────────────┐
   │ Local daemon │ ──────────────────▶ │ ~/.claude  +  .claude/ │
   │     (Go)     │                     │  (uživatel + projekty) │
   └──────────────┘                     └────────────────────────┘
```

- Prohlížeč nikdy nesahá na souborový systém — všechno jde přes daemon.
- Daemon vrací **preview** každé operace a teprve po potvrzení zapisuje.
- Hub API zná jen hash spárovaného zařízení; token zůstává na počítači uživatele.

## Rychlý start

Předpoklady:

- **Node.js ≥ 22**, **npm ≥ 10**
- **Go 1.26** (pouze pro daemon mimo Docker)
- **git ≥ 2.20** (daemon ho používá pro klonování plugin marketplace repos)
- **Docker Desktop** (pro úplné spuštění včetně Postgresu)

### Varianta A — všechno přes Docker

```bash
git clone https://github.com/animato-lab/claude-hub.git
cd claude-hub
npm run docker:up
```

Skript spustí `compose.yaml + compose.dev.yaml` — base stack (postgres, api, web) plus `daemon` službu pro lokální dev.

Otevřete:

- web aplikace — <http://localhost:3000>
- registry API health — <http://localhost:8787/health>
- daemon hello — <http://localhost:17373/v1/hello>
- Postgres — `localhost:15432` (DB `claude_hub`, uživatel `claude_hub`)

> **Vlastní porty?** Zkopírujte `compose.override.yaml.example` jako `compose.override.yaml` — Docker Compose ho automaticky merguje a typicky vrátí web na 3100, Postgres na 5432. Soubor je v `.gitignore`, takže si může každý vývojář držet vlastní.

Vyzvedněte párovací token:

```bash
docker compose logs daemon | grep "Pairing token"
```

V aplikaci klikněte **Spárovat** (popup formulář daemonu) nebo vložte token ručně.

Zastavení stacku:

```bash
npm run docker:down
```

### Varianta B — lokálně bez Dockeru

```bash
npm install
docker compose up postgres                 # nebo libovolný Postgres 16+
set CLAUDE_HUB_DATABASE_URL=postgres://claude_hub:claude_hub@127.0.0.1:15432/claude_hub
set CLAUDE_HUB_API_URL=http://127.0.0.1:8787

# tři terminály
npm run dev:api
npm run dev:web
npm run dev:daemon
```

> Pokud používáte `compose.override.yaml` s portem 5432, upravte connection string na `@127.0.0.1:5432`.

Výchozí URL:

| Služba       | URL                          |
| ------------ | ---------------------------- |
| web          | <http://localhost:3000>      |
| registry API | <http://127.0.0.1:8787>      |
| daemon       | <http://127.0.0.1:17373>     |

Daemon při startu vypíše párovací token a cestu k souboru `daemon-token` v `~/.claude/.claude-hub/`. Token zkopírujte do webu (pole „Zadat token ručně") nebo použijte tlačítko **Spárovat**, které otevře potvrzovací stránku daemonu.

## Vývojové prostředí

### Struktura workspaců

`package.json` v rootu drží npm workspaces:

```json
{
  "workspaces": ["apps/web", "apps/api", "packages/schema"]
}
```

Daemon je samostatný Go modul řízený souborem `go.work`. Nepoužívá npm.

### Důležité npm skripty

| Skript                  | Co dělá                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `npm run dev:web`       | `next dev --turbo` v `apps/web`                                        |
| `npm run dev:api`       | `tsx watch src/server.ts` v `apps/api`                                 |
| `npm run dev:daemon`    | `go run ./apps/daemon/cmd/claude-hub-daemon`                           |
| `npm run build`         | Build všech workspaců (`tsc`, `next build`)                            |
| `npm run typecheck`     | TypeScript kontrola napříč workspacy                                   |
| `npm test`              | npm testy + `go test ./apps/daemon/...`                                |
| `npm run test:daemon`   | Pouze Go testy daemonu                                                 |
| `npm run docker:up`     | `docker compose up --build`                                            |
| `npm run docker:down`   | Zastavení stacku                                                       |
| `npm run docker:logs`   | Tail logy služeb                                                       |

### Hot reload

- **Web**: Next.js Turbo dev server.
- **API**: `tsx watch` přebuilduje při změně `.ts`.
- **Daemon**: `go run` se musí ručně restartovat (Ctrl+C → znovu).

## Docker Desktop

Soubor `compose.dev.yaml` (lokální dev overlay) připojuje `daemon` k vašemu skutečnému Claude Code home a k pracovnímu rootu:

```yaml
volumes:
  - ${USERPROFILE}/.claude:/data/claude
  - ${CLAUDE_HUB_WORKSPACE_ROOT_D:-D:/Claude}:/workspace-roots/d-claude
```

Díky tomu web zobrazí reálné uživatelské skilly, příkazy, hooky, MCP konfigurace a pluginy a navíc i project-level assety z `D:\Claude\<projekt>\.claude\`. Pokud máte projekty jinde, nastavte před spuštěním:

```bash
set CLAUDE_HUB_WORKSPACE_ROOT_D=E:\Workspace
npm run docker:up
```

### Produkční deploy (NAS / server)

Pro produkci stačí samotný `compose.yaml` — žádný daemon, všechny porty bindované jen na `127.0.0.1` (přístup zvenčí řeší reverse proxy):

```bash
git pull
docker compose up -d --build
```

Web posloucháme na `127.0.0.1:3000`, API na `127.0.0.1:8787`, Postgres na `127.0.0.1:15432` (port 15432, aby nekolidoval se systémovým Postgresem na Synology NASu).

## Konfigurace přes proměnné prostředí

### Registry API (`apps/api`)

| Proměnná                                | Výchozí       | Význam                                                   |
| --------------------------------------- | ------------- | -------------------------------------------------------- |
| `CLAUDE_HUB_DATABASE_URL`               | _povinné_     | Postgres connection string                               |
| `CLAUDE_HUB_API_HOST`                   | `127.0.0.1`   | Host pro Fastify listener                                |
| `CLAUDE_HUB_API_PORT`                   | `8787`        | Port pro Fastify listener                                |
| `CLAUDE_HUB_SESSION_CLEANUP_INTERVAL_MS`| `3600000`     | Frekvence úklidu expirovaných sessions (1 hodina)         |
| `CLAUDE_HUB_TEAM_ID`                    | `main`        | Identifikátor jediného týmu (single-tenant). API i web musí mít stejnou hodnotu. |
| `CLAUDE_HUB_TEAM_NAME`                  | `Tým`         | Zobrazované jméno týmu v UI                              |
| `CLAUDE_HUB_TEST_DATABASE_URL`          | —             | Alternativní DB pro integrační testy                     |

### Web (`apps/web`)

| Proměnná                          | Výchozí                                  | Význam                                              |
| --------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| `CLAUDE_HUB_API_URL`              | _povinné_                                | URL registry API (server-side fetch)                |
| `CLAUDE_HUB_PUBLIC_URL`           | `https://hub.animato-lab.cz`             | Veřejná URL Hubu (pro instalační hint daemonu)      |
| `CLAUDE_HUB_DAEMON_BREW_PACKAGE`  | `animato-lab/tap/claude-hub-daemon`      | Hint pro instalaci daemonu na macOS                 |
| `CLAUDE_HUB_DAEMON_WINGET_ID`     | `Animato.ClaudeHubDaemon`                | Hint pro instalaci daemonu na Windows               |
| `CLAUDE_HUB_TEAM_ID`              | `main`                                   | Identifikátor jediného týmu — musí odpovídat hodnotě v API |
| `CLAUDE_HUB_TEAM_NAME`            | `Tým`                                    | Zobrazované jméno týmu v UI                         |

### Daemon (`apps/daemon`)

| Proměnná / flag                       | Výchozí                       | Význam                                                                    |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `-host` / `CLAUDE_HUB_DAEMON_HOST`    | `127.0.0.1`                   | Bind host. Měňte jen vědomě — vystavujete API mimo localhost.             |
| `-port` / `CLAUDE_HUB_DAEMON_PORT`    | `17373`                       | Port daemonu                                                              |
| `-claude-home` / `CLAUDE_HOME`        | `~/.claude` (resp. `%USERPROFILE%\.claude`) | Cesta ke Claude Code home                                                 |
| `CLAUDE_HUB_WORKSPACE_ROOTS`          | —                             | Cesty (PATH-style oddělené `;`/`:`), v nichž se hledají projektové `.claude` |
| `CLAUDE_HUB_WORKSPACE_ROOT`           | —                             | Fallback pro jediný pracovní root                                         |
| `CLAUDE_HUB_ALLOWED_WEB_ORIGINS`      | —                             | Čárkou/mezerou oddělený seznam povolených origins nad rámec localhostu    |

Pro produkční doménu (`https://hub.animato-lab.cz`) musí lokální daemon povolit tento origin:

```bash
set CLAUDE_HUB_ALLOWED_WEB_ORIGINS=https://hub.animato-lab.cz
claude-hub-daemon
```

Web aplikace stále komunikuje s daemonem přes `http://127.0.0.1:17373`. Daemon **neakceptuje libovolné weby** — povolené jsou pouze localhost vývojové origins a explicitně vyjmenované přes proměnnou.

## Verifikace a testy

```bash
npm run typecheck    # TypeScript napříč workspacy
npm run build        # Build webu, API, schema balíčku
npm test             # Node test runner + go test
```

- **Daemon**: čistý `go test ./apps/daemon/...` (`apps/daemon/internal/claudecode/manager_test.go`) ověřuje install/enable/disable cykly a detekci „osiřelého" manifestu.
- **API**: `apps/api/src/repository.test.ts` je integrační test proti Postgresu. Bez `CLAUDE_HUB_TEST_DATABASE_URL` se přeskakuje.

## Bezpečnostní model

- Daemon poslouchá pouze na `127.0.0.1` a vyžaduje `Authorization: Bearer <token>` u všech mutací.
- Token (24 náhodných bajtů, base64url) se generuje při prvním startu a ukládá s právy `0600` do `~/.claude/.claude-hub/daemon-token`.
- CORS: povolené jsou jen `localhost`/`127.0.0.1`/`[::1]` origins, plus volitelně produkční Hub doména přes `CLAUDE_HUB_ALLOWED_WEB_ORIGINS`.
- Před každým zápisem se vrací **preview** s typem operace (`create`, `replace`, `backup`, `manifest`, `enable`, `disable`) a rizikovou úrovní.
- Zálohy se ukládají do `~/.claude/.claude-hub/backups/<timestamp>-<type>-<slug>/`.
- Při exportu položky daemon:
  - povolí pouze UTF-8 text do **512 KiB** na soubor,
  - z `settings.json` exportuje **pouze sekci `hooks`** (nikdy celý soubor s tokeny),
  - varuje při výskytu řetězců typu `api_key=`, `token:`, `password:` nebo cest svázaných s konkrétním počítačem (`C:\Users\…`, `/home/…`).

### Úrovně rizika u assetů

| Riziko       | Co tam patří                                                          |
| ------------ | --------------------------------------------------------------------- |
| `low`        | Skilly a čistě textové prompty                                        |
| `medium`     | Slash příkazy a konfigurační assety                                   |
| `high`       | MCP servery, hooky, pluginy — vše, co spouští kód                     |
| `restricted` | Položky s ručně omezeným přístupem                                    |

## Aktuální rozsah a roadmapa

### Implementováno

- Next.js katalog s párováním lokálního daemonu
- Email login, logout, HTTP-only session cookie, metadata spárovaných zařízení
- České UI pro katalog, sady, tým, klíče a nahrávání z lokálu
- Server-side klient registry API s lokálním fallbackem
- TypeScript/Fastify registry API s Postgres backendem
- Go daemon s autentizovaným localhost API
- Detekce uživatelských skillů, příkazů, hooků (`settings.json`), MCP konfigurací a nainstalovaných pluginů
- Detekce stejných assetů na úrovni projektů (`<project>/.claude/...`)
- **Plný install/uninstall lifecycle pro skill, command, MCP, hook a plugin** (MCP/hook přes merge do existujícího souboru, plugin přes filesystem zápis)
- Diff endpoint pro skill/command s LCS line-level porovnáním
- Verze + audit log + admin rollback
- **Teams, members, invitations** (auto-create personal team při loginu)
- **Sady (collections)** pro tematické balíčky položek
- **Ed25519 podepisování balíčků** — generování klíče v UI, podpis při publish, ověření v API
- Postgres + Go testy včetně merge integračních testů
- **goreleaser** pipeline (Linux/macOS/Windows × amd64/arm64), Homebrew tap, Scoop bucket, winget manifest

### Připravujeme

- E-mailová brána pro odesílání pozvánek (Postmark / Resend)
- Sémantický diff pro MCP / hook merge dokumenty
- Workspace root management přímo z webu
- Vylepšené high-risk policy pro plugin install

## Další dokumentace

- [`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md) — produktový plán a principy.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — detailní průvodce architekturou, datový model, stavový model assetů.
- [`docs/API.md`](docs/API.md) — referenční dokumentace HTTP rozhraní registry API.
- [`docs/DAEMON.md`](docs/DAEMON.md) — specifikace lokální Go služby, endpointy, bezpečnostní kontroly.
- [`docs/WEB.md`](docs/WEB.md) — průvodce Next.js aplikací, server actions a UI komponentami.
- [`docs/SCHEMA.md`](docs/SCHEMA.md) — datové typy z `@claude-hub/schema`.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — praktický průvodce pro vývojáře, debugging a typické scénáře.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — produkční nasazení, nginx konfigurace, DR plán.
- [`CHANGELOG.md`](CHANGELOG.md) — historie změn.
