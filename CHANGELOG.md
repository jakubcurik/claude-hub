# Changelog

Pro tento projekt používáme [Keep a Changelog](https://keepachangelog.com/cs/) a [Semantic Versioning](https://semver.org/lang/cs/).

## [Unreleased]

### Opraveno

- Web již nepoužívá neexistující `refresh()` z `next/cache` — místo toho `revalidatePath("/")`.
- Daemon při reinstalaci skillu maže starý adresář, aby zmizely soubory odstraněné z nové verze.
- `compose.yaml` volby cest podporuje `${USERPROFILE}` i `${HOME}` napříč OS.
- `RiskLevel` v Go nyní zahrnuje `restricted` v souladu s TypeScript typy.
- JSON Schema doplněno o všechny vlastnosti, které vyžadují `required`.
- Manifest `contentFingerprint` se aktualizuje po `set-enabled`, takže toggle nezpůsobí falešné `local_changes`.

### Přidáno

- API: rate-limit 10 req/min na `POST /v1/auth/login` (`@fastify/rate-limit`).
- API: `/health` ověřuje skutečnou dostupnost Postgresu (503 při výpadku).
- API: periodický úklid expirovaných sessions (`hub_sessions`).
- API: tabulka `catalog_asset_versions` s plnou historií verzí.
- API: tabulka `catalog_events` jako audit log (publish / install / enable / disable / uninstall / update).
- API: nové endpointy `/v1/devices` (GET / DELETE), `/v1/teams/:teamId/events`, `/v1/teams/:teamId/catalog/:type/:slug/versions`.
- API: pole `content_hash` u katalogu pro budoucí integritní kontrolu.
- API: structured error response `{ error, code, message }`.
- Daemon: endpoint `POST /v1/uninstall` se zálohou před smazáním.
- Daemon: `sync.Mutex` per `(type, slug)` proti souběžným install operacím.
- Daemon: export adresáře nevrací error, ale warning o přeskočených binárních souborech.
- Daemon: capability `uninstall` v `/v1/hello`.
- Web: tlačítko **Odinstalovat** na kartách katalogu.
- Web: panel **Spárovaná zařízení** v sidebaru s možností revoknout.
- Web: skeletony při načítání katalogu.
- Web: server actions `listPairedDevices`, `revokePairedDevice`, `logCatalogEvent`.
- DX: Prettier, ESLint, golangci-lint konfigurace.
- DX: GitHub Actions CI workflow (`node`, `daemon` job, integrace s Postgresem).
- Testy: server HTTP testy daemonu (`server_test.go`).
- Dokumentace: `docs/DEPLOYMENT.md` (produkční nasazení, nginx config, DR plán).

### Přidáno (Fáze H–O)

- **Single-tenant tým**: instance Claude Hubu má vždy jeden tým definovaný proměnnými `CLAUDE_HUB_TEAM_ID` (default `main`) a `CLAUDE_HUB_TEAM_NAME` (default `Tým`). Pokud chce jiná firma vlastní katalog, self-hostuje vlastní instanci.
- **Auto-membership**: každý uživatel, který se poprvé přihlásí, je automaticky přidaný do týmu. První uživatel ever získá roli `owner`, ostatní `member`. Admin může role změnit nebo členy odebrat — pokud odebraný uživatel se znovu přihlásí, automaticky se NEpřidá zpět.
- **Team management UI**: panel **Tým** se seznamem členů, změnou rolí a odebíráním (žádný team picker, žádné invitations — všichni jsou v jedné instanci).
- **MCP install/uninstall**: daemon umí mergovat `mcpServers` v `.mcp.json` se zachováním ostatních serverů. Disable přesune klíče do stash souboru pro rychlé re-enable.
- **Hook install/uninstall**: merge sekce `hooks` v `settings.json`. Manifest si pamatuje indexy přidaných položek pro cílený uninstall.
- **Plugin install**: zápis pluginu do `~/.claude/plugins/<slug>/` + aktualizace `installed_plugins.json`.
- **Diff endpoint**: `POST /v1/diff` vrací line-level LCS diff pro skill/command assety. UI obsahuje **DiffModal** s color-coded zobrazením.
- **Collections**: tabulka `collections`, CRUD endpointy, **CollectionsPanel** s editorem.
- **Versions + rollback**: tabulka `catalog_asset_versions` (už dříve), nový endpoint `POST /v1/teams/:teamId/catalog/:type/:slug/rollback`, **VersionsModal** s rollback tlačítkem pro adminy.
- **Audit log**: tabulka `catalog_events` (už dříve), endpointy `GET/POST /v1/teams/:teamId/events`, klient loguje install/update/disable/uninstall.
- **Ed25519 signing**: tabulka `signing_keys`, endpointy pro správu klíčů. Web umí vygenerovat keypair (Node `crypto.generateKeyPair`), publikovat s podpisem (`publishWithSignature`), API ověří přes Ed25519 verify. UI panel **Klíče** s reveal modalem na stažení PEM.
- **Versions zobrazení**: tlačítko **Verze** na každé kartě otevře modal s historií publikací včetně značky „podepsáno".
- **Goreleaser pipeline**: `.goreleaser.yaml` s cross-compile pro Linux/macOS/Windows × amd64/arm64, Homebrew tap + Scoop bucket bindings. GitHub Action `release.yml` se spustí na tag `v*`. Winget manifest templaty v `packaging/winget/`. Lokální dry-run `scripts/release-snapshot.sh`.
- **Daemon capabilities** v `/hello` rozšířené o `diff`, `mcp-merge`, `hook-merge`, `plugin-install`.
- **Testy**: 4 nové integrační testy daemonu (`merge_test.go`) pokrývají MCP merge, MCP toggle, hook append/remove, plugin install/uninstall.

### Známá omezení (po Fázi O)

- Žádný invitation flow — admin přidá člena až po jeho registraci přes e-mail (uživatel se sám přihlásí přes `/login`, pak ho admin přidá v UI nebo přes `POST /v1/teams/:teamId/members`).
- Diff endpoint zatím semanticky neporovnává MCP / hook merge dokumenty (kvůli složitosti JSON struktur).
- Goreleaser tap/scoop bucket vyžadují skutečné GitHub repo (`animato-lab/homebrew-tap`, `animato-lab/scoop-bucket`) — jsou v configu, ale musí se vytvořit.
- Winget publishing je manuální PR — workflow jen připraví manifesty.
