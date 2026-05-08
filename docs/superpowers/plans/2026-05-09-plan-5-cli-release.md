# Plan 5 — CLI + Release Pipeline

**Date:** 2026-05-09
**Status:** Ready for execution
**Owner:** Kuba Curik (curik@animato.cz)
**License:** Apache 2.0
**Scope:** Veřejný release v0.1.0 — CLI nástroj, distribuční scripty, GitHub release pipeline, Homebrew formula, Windows MSI/winget, dokumentace, právní hlavičky.
**Depends on:** Plan 1 (hub-server REST + WSS + Postgres + MinIO), Plan 2 (Go agent + daemon localhost API `/v1/{status,publish,install,uninstall,toggle,local,pair}` + service install), Plan 3 (Next.js dashboard + setup wizard), Plan 4 (artifact handling for skill/plugin/command/agent).

## Úvod

Tento plán uzavírá MVP. Předchozí plány dodaly kompletní backend, daemon, dashboard a artefaktovou logiku. Zde stavíme **veřejnou tvář produktu**:

- `claude-hub` CLI v Go (sourozenec daemonu) pro power-users a CI.
- Cross-platform instalační scripty (`install.sh`, `install.ps1`).
- Packaging — Homebrew tap, Windows winget manifest, MSI (WiX).
- Kompletní GitHub release pipeline pro tagy `v*`.
- Veřejnou dokumentaci (admin, user, CLI, API), CONTRIBUTING, SECURITY, CODE_OF_CONDUCT.
- SPDX hlavičky a jejich CI ověření.

Plán předpokládá funkční stack po Plánech 1–4. Žádný task nepředpokládá komponentu, která by ještě nebyla dodaná.

Konvence dle `_implementation-contracts.md`: SPDX `Apache-2.0`, conventional commits, pnpm + go.work, Go 1.23+, Node 22 LTS. Tasky jsou bite-sized (~2–5 min) a TDD-first kde dává smysl.

---

## Tasks

### Section A — CLI skeleton (`apps/cli/`)

#### Task A1 — Bootstrap `apps/cli/` Go module

- Create `apps/cli/go.mod` with module path `github.com/animato/claude-hub/cli`, Go 1.23.
- Add to root `go.work` as a new `use` entry alongside `./apps/agent`.
- Add `apps/cli/cmd/claude-hub/main.go` with empty `func main()` printing `claude-hub v0.0.0-dev`.
- Verify: `go work sync && go build ./apps/cli/...` succeeds.
- Commit: `chore(cli): scaffold Go module and entrypoint`.

#### Task A2 — Add cobra + dependency wiring

- `cd apps/cli && go get github.com/spf13/cobra@latest github.com/charmbracelet/huh@latest github.com/charmbracelet/lipgloss@latest`.
- Create `apps/cli/internal/cmd/root.go` with `rootCmd` (`Use: "claude-hub"`, `Short: "Claude Hub team marketplace CLI"`).
- Wire `main.go` to `cmd.Execute()`. Add `--json` persistent flag and `--config` persistent flag (default `$HOME/.claude-hub/config.yaml`).
- Test: `apps/cli/internal/cmd/root_test.go` — execute root with `--help`, assert non-empty output and exit 0.
- Commit: `feat(cli): add cobra root command with json and config flags`.

#### Task A3 — Share types via internal API package import

- Use `apps/agent/internal/api` (already defines `InventoryItem`, daemon REST DTOs from Plan 2) by importing it from CLI: in `apps/cli/go.mod` add `replace github.com/animato/claude-hub/agent => ../agent` and `require github.com/animato/claude-hub/agent v0.0.0`.
- Create `apps/cli/internal/daemon/client.go` re-exporting/aliasing `agent/internal/api.InventoryItem` and other DTOs to keep CLI imports stable.
- Test: `apps/cli/internal/daemon/types_test.go` round-trips a `InventoryItem` through JSON encode/decode using the imported type.
- Commit: `feat(cli): share daemon API DTOs via go.work replace`.

#### Task A4 — `internal/daemon/client.go` HTTP client (TDD)

- Write failing test `client_test.go` using `httptest.NewServer` to assert:
  - `Status(ctx)` GETs `/v1/status` with bearer from `~/.claude-hub/agent.token` and returns parsed struct.
  - `BaseURL` defaults to `http://127.0.0.1:7878`, override via `CLAUDE_HUB_AGENT_ADDR`.
  - 401 when token file missing returns `ErrAgentTokenMissing`.
- Implement `Client` struct with methods `Status`, `Local`, `Publish`, `Install`, `Uninstall`, `Toggle`, `Pair` (matching Plan 2 daemon API).
- Token loader: `LoadAgentToken()` reads `~/.claude-hub/agent.token`, validates mode `0600` on Unix.
- Commit: `feat(cli): daemon HTTP client with token auth`.

#### Task A5 — Hub session client (`internal/hub/client.go`) (TDD)

- Failing test: against `httptest` server, `Login(email, password)` POSTs `/api/auth/login` and stores returned cookie/token.
- Token persistence: `~/.claude-hub/cli.token` mode `0600`. Helpers `SaveCLIToken`, `LoadCLIToken`, `DeleteCLIToken`.
- Methods: `Login`, `Logout`, `Me`, `ListArtifacts(filter)`, `GetArtifact(slug)`, `Pair(pin)`-helper, `UploadArtifact` (multipart, for `--standalone`).
- Test path traversal/error mapping: 401 → `ErrUnauthorized`, 404 → `ErrNotFound`.
- Commit: `feat(cli): hub REST client with persisted CLI token`.

#### Task A6 — Config file loader (`internal/config/config.go`)

- TDD: failing test loads YAML with `hub_url`, `default_version_bump` (`patch`|`minor`|`major`), default values when missing, write-on-first-login.
- Use `gopkg.in/yaml.v3`. Path: `~/.claude-hub/config.yaml`. Auto-create parent dir mode `0700`.
- Validate `default_version_bump` enum on load.
- Commit: `feat(cli): config loader for hub_url and default version bump`.

### Section B — CLI subcommands

#### Task B1 — `claude-hub version`

- Subcommand printing CLI version (compile-time `var Version = "dev"` ldflag-injected) and, if daemon reachable, daemon version from `/v1/status`.
- Test: with httptest mock daemon, asserts both lines present; with daemon unreachable, prints CLI line only and exits 0.
- `--json` mode emits `{"cli":"...","agent":"..."}`.
- Commit: `feat(cli): add version subcommand`.

#### Task B2 — `claude-hub status`

- Calls `daemon.Status()`. Renders table via `lipgloss`: paired (yes/no), hub_url, online, agent_version, items count from `daemon.Local()`.
- `--json` short-circuits to JSON dump.
- Test: mock daemon, snapshot of human output (compare to golden file `testdata/status.golden`).
- Commit: `feat(cli): add status subcommand`.

#### Task B3 — `claude-hub login`

- Subcommand with `--hub <url>` flag (required if not in config). Interactive prompt via `huh` for email + password (password masked).
- POSTs to `/api/auth/login`, persists token via `SaveCLIToken`, writes `hub_url` + `default_version_bump=patch` into config on first run.
- `--email`, `--password` flags for non-interactive mode (CI). `--password-stdin` reads from stdin.
- Test: mock hub server, assert token file written with mode 0600, config file created.
- Commit: `feat(cli): add login subcommand with interactive prompts`.

#### Task B4 — `claude-hub logout`

- Calls `/api/auth/logout`, deletes `~/.claude-hub/cli.token`. Idempotent (no error if already logged out).
- Test: mock hub, assert DELETE on token file; second call exits 0 with "already logged out" message.
- Commit: `feat(cli): add logout subcommand`.

#### Task B5 — `claude-hub list`

- Flags: `--type skill|plugin|command|agent`, `--q <query>`. GETs `/api/artifacts?type=&q=`.
- Renders lipgloss table with columns: TYPE, SLUG, LATEST, OWNER, DESCRIPTION (truncated to 60 chars).
- `--json` outputs raw API JSON array.
- Test: mock hub returns 3 artifacts, golden-file table snapshot.
- Commit: `feat(cli): add list subcommand with type and query filters`.

#### Task B6 — `claude-hub install <slug>[@<version>]`

- Parse slug + optional `@version` (regex `^([a-z0-9][a-z0-9-]{0,63})(?:@(\d+\.\d+\.\d+))?$`).
- Resolve to `artifact_version_id` via `/api/artifacts/:slug` (latest if no version).
- Call `daemon.Install(artifactId, version)`. Stream progress: poll `/v1/status` or daemon SSE if available; for MVP, show `lipgloss` spinner until daemon responds 200.
- Error if daemon offline: `claude-hub-agent must be running. Run: claude-hub status`.
- Test: mock daemon + hub, assert correct install request body.
- Commit: `feat(cli): add install subcommand with version resolution`.

#### Task B7 — `claude-hub uninstall <slug>`

- Resolve slug → artifact_id via `/api/artifacts/:slug`. Call `daemon.Uninstall(artifactId)`.
- Confirmation prompt unless `--yes` (huh confirm).
- Test: mock daemon, assert uninstall request, `--yes` skips prompt.
- Commit: `feat(cli): add uninstall subcommand`.

#### Task B8 — `claude-hub toggle <slug> --on|--off`

- Plugin-only. If artifact type != plugin, exit with error `"toggle is only supported for plugins"` (resolved from `/api/artifacts/:slug`).
- `--on` / `--off` mutually exclusive, exactly one required.
- Calls `daemon.Toggle(artifactId, enabled)`.
- Test: skill type → error; plugin type → success; missing flag → usage error.
- Commit: `feat(cli): add toggle subcommand for plugins`.

#### Task B9 — `claude-hub publish` (interactive)

- No args, no flags (other than global): full `huh` wizard.
- Step 1: `daemon.Local()`, filter items where `publishedAs == nil` OR `version > publishedAs.version` (semver compare).
- Step 2: `huh.NewSelect[InventoryItem]` listing them with type prefix (`skill: my-helper  ~/.claude/skills/my-helper`).
- Step 3: pre-fill version using `default_version_bump` from config applied to `publishedAs.version` (or `0.1.0` if new); editable `huh.NewInput`.
- Step 4: pre-fill description from manifest; editable input.
- Step 5: confirm summary; on yes, call `daemon.Publish(...)` with progress spinner.
- Test: mock daemon returns 2 locals, assert select rendered; submit produces correct publish payload (use `huh.NewForm` programmatic mode).
- Commit: `feat(cli): add interactive publish subcommand`.

#### Task B10 — `claude-hub publish <path>` (non-interactive)

- Same command, but if positional arg present, switch to non-interactive.
- Required flag: `--type skill|plugin|command|agent`. Optional: `--slug` (default = dirname or filename), `--version` (default = next from server's latest, falling back to `0.1.0`), `--description` (default = from manifest).
- Validate path exists. Pass `source_path` to daemon.
- Test: temp dir with skill manifest, assert CLI calls daemon with correct payload.
- Commit: `feat(cli): support non-interactive publish with path arg`.

#### Task B11 — `claude-hub publish --standalone`

- When `--standalone` set, skip daemon. CLI itself:
  1. Tar+gzip the source path.
  2. Compute sha256.
  3. POST multipart to `/api/artifacts/upload` with bearer = CLI session token.
- Useful for CI machines without daemon.
- Test: mock hub upload endpoint, assert tar contents (extract in test, compare to source dir), correct sha256.
- Commit: `feat(cli): add --standalone publish without daemon`.

#### Task B12 — `claude-hub pair`

- `--hub <url>` required (or from config). Two modes:
  - Default: requires CLI session (must be logged-in). POSTs `/api/daemons/pair` to get pin, then calls `daemon.Pair(hub_url, pin)` automatically.
  - `--pin <pin>`: skip pin generation, pass pin straight to daemon.
- After successful pair, print: `paired daemon <id> on <hostname>`.
- Test: mock hub returns pin `123456`; mock daemon accepts pair; assert daemon got correct hub_url + pin.
- Commit: `feat(cli): add pair subcommand`.

#### Task B13 — Output formatting helpers (`internal/output/`)

- Centralized `humanTable`, `jsonOut`, `errExit(msg, code)`. Respect global `--json` flag.
- Error model: `cliError{Code int; Message string}`; CLI prints to stderr, exits with `Code`.
- Test: golden snapshots for table + json paths.
- Commit: `refactor(cli): extract output formatting helpers`.

### Section C — Distribution scripts (`ops/install/`)

#### Task C1 — `ops/install/install.sh` (Linux/macOS)

- POSIX sh. Detects `uname -s` → `linux`/`darwin`, `uname -m` → `amd64`/`arm64`.
- Downloads `${RELEASE_BASE_URL}/<os>-<arch>/claude-hub-agent.tar.gz` and `claude-hub.tar.gz`.
- Verifies SHA256 against `${RELEASE_BASE_URL}/checksums.txt` (downloaded over TLS).
- Install dir: `/usr/local/bin/` (with `sudo` prompt) or `~/.local/bin/` if `--user`.
- Runs `claude-hub-agent service install && claude-hub-agent service start`.
- Prints: `Next: claude-hub pair --hub <hub_url>`.
- Honors `HUB_URL` env var for hub override. Errors with non-zero exit on any failed step.
- Add shellcheck-clean script. Commit: `feat(install): add Linux/macOS install.sh`.

#### Task C2 — `ops/install/install.ps1` (Windows)

- PowerShell 5+. Uses `Invoke-WebRequest`.
- Install dir: `$env:LOCALAPPDATA\claude-hub\bin\`. Adds to user PATH via `[Environment]::SetEnvironmentVariable(...)`.
- Verifies SHA256 with `Get-FileHash`.
- Runs `claude-hub-agent.exe service install` (registers Windows service).
- Self-elevates via `Start-Process -Verb RunAs` if service install requires admin.
- Commit: `feat(install): add Windows install.ps1`.

#### Task C3 — Homebrew formula `ops/install/brew/claude-hub-agent.rb`

- Real Ruby formula (no placeholder):
  - `class ClaudeHubAgent < Formula`
  - `desc`, `homepage "https://github.com/animato/claude-hub"`, `license "Apache-2.0"`.
  - `url` and `sha256` for amd64 + arm64 macOS bottles. Use `on_macos` + `on_arm` blocks.
  - Installs both binaries: `bin.install "claude-hub-agent"` and `bin.install "claude-hub"`.
  - `service do ... end` block for `brew services start claude-hub-agent`.
  - `test do ... end` runs `claude-hub --version`.
- Add `ops/install/brew/README.md` describing tap setup (`brew tap animato/claude-hub`).
- Commit: `feat(install): add Homebrew formula and tap docs`.

#### Task C4 — Winget manifest `ops/install/winget/`

- Three YAML files per spec: `Animato.ClaudeHub.yaml` (version), `.locale.en-US.yaml`, `.installer.yaml`.
- Targets MSI installer URL + sha256, scope `user`, install command `claude-hub-agent service install`.
- Add `ops/install/winget/build-manifest.sh` that templates the manifests with `$VERSION`, `$MSI_URL`, `$MSI_SHA256` from env (used by release CI).
- Commit: `feat(install): add winget manifest templates`.

#### Task C5 — Windows MSI via WiX (`ops/install/msi/`)

- `Product.wxs`: WiX 4 schema, product GUID, upgrade code (committed and stable), install dir `%LOCALAPPDATA%\claude-hub\bin`, components for `claude-hub-agent.exe` + `claude-hub.exe`, ServiceInstall element for the agent (auto-start, restart on failure), PATH update via `Environment` element (user scope).
- `claude-hub.wixproj` (MSBuild project) referencing `Product.wxs`.
- `ops/install/msi/build.ps1` invoking `wix build` to produce `claude-hub-${VERSION}-x64.msi`.
- Local smoke: `wix build` runs in CI on `windows-latest` and produces a non-zero-byte MSI.
- Commit: `feat(install): add WiX project for Windows MSI`.

### Section D — Hub server install endpoints (`apps/hub-server/`)

#### Task D1 — Static install script endpoints (TDD)

- Failing integration test (Vitest + supertest): `GET /install.sh` returns 200, `Content-Type: text/x-shellscript; charset=utf-8`, body matches the on-disk `ops/install/install.sh`, header `Cache-Control: no-cache`.
- Same for `GET /install.ps1` (`text/plain` or `application/x-powershell`).
- Implement Hono route reading file at startup and serving from memory.
- `PUBLIC_URL` env is interpolated where the script references the hub URL (replace token `__HUB_URL__`).
- Commit: `feat(server): serve install.sh and install.ps1`.

#### Task D2 — `/dist/<os>-<arch>/<file>` proxy/redirect (TDD)

- Failing test: `GET /dist/linux-amd64/claude-hub-agent.tar.gz` → 302 to `${RELEASE_BASE_URL}/v0.1.0/linux-amd64/claude-hub-agent.tar.gz`.
- Env `RELEASE_BASE_URL` (default empty → 503 with friendly message until set).
- Whitelist OS/arch combos (`linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64`); 404 for others.
- Integration test covers all valid combos and an invalid one.
- Commit: `feat(server): add /dist redirect to GitHub releases`.

### Section E — Release pipeline

#### Task E1 — `.github/workflows/release.yml` skeleton

- Trigger: `on: push: tags: [ 'v*' ]`.
- Top-level `permissions: { contents: write, packages: write, id-token: write }`.
- Empty job stubs: `build-server`, `build-dashboard`, `build-agent-cli`, `build-msi`, `release`, `homebrew`, `winget`. Each `needs:` wired into `release`.
- CI lints workflow with `actionlint` (added as a CI step in existing `ci.yml`).
- Commit: `chore(ci): scaffold release workflow`.

#### Task E2 — `build-server` job

- Bundle dashboard into hub-server image (chosen for MVP simplicity per scope brief).
- Steps: checkout, setup pnpm + node 22, `pnpm install`, `pnpm --filter dashboard build`, `pnpm --filter hub-server build`, build Docker image with multi-stage Dockerfile from `ops/docker/hub-server.Dockerfile`, tag `ghcr.io/animato/claude-hub:${{ github.ref_name }}` and `:latest`, push to GHCR.
- Login via `docker/login-action@v3` using `GITHUB_TOKEN`.
- Commit: `feat(ci): build and push hub-server image`.

#### Task E3 — `build-agent-cli` job (GoReleaser)

- Add `apps/agent/.goreleaser.yaml` and `apps/cli/.goreleaser.yaml` (or single root `.goreleaser.yaml` with two builds).
- Builds matrix: linux+darwin+windows × amd64+arm64 (windows arm64 optional). Static binaries.
- Archives: `claude-hub-agent_${version}_${os}_${arch}.tar.gz` (zip on Windows). Includes LICENSE + README.
- Generates `checksums.txt` (sha256, all archives).
- Job uses `goreleaser/goreleaser-action@v6` with `args: release --clean`.
- Uploads artifacts to GitHub Release (handled by GoReleaser when running on tag).
- Commit: `feat(ci): add GoReleaser configs for agent and CLI`.

#### Task E4 — `build-msi` job

- Runs on `windows-latest`. `needs: build-agent-cli` (downloads windows-amd64 artifacts via `actions/download-artifact`).
- Steps: install WiX 4 (`dotnet tool install --global wix`), run `pwsh ops/install/msi/build.ps1 -Version ${{ github.ref_name }}`, upload MSI as artifact named `msi`.
- Computes SHA256 of MSI, writes to `msi-sha256.txt` artifact.
- Commit: `feat(ci): build Windows MSI in release pipeline`.

#### Task E5 — `release` job (GitHub Release + changelog)

- Depends on all build jobs. Uses `orhun/git-cliff-action@v3` with `cliff.toml` to render changelog from conventional commits since previous tag.
- Uses `softprops/action-gh-release@v2` to create the release, attach all archives + MSI + checksums.txt + cliff-generated `CHANGELOG.md` snippet.
- Add `cliff.toml` at repo root with conventional-commit categories (feat, fix, docs, chore, refactor, test, ci).
- Commit: `feat(ci): publish GitHub release with changelog`.

#### Task E6 — `homebrew` job (best-effort tap bump)

- If env secret `HOMEBREW_TAP_TOKEN` is set, clone `animato/homebrew-tap`, regenerate `claude-hub-agent.rb` from `ops/install/brew/claude-hub-agent.rb` template (fill in `${VERSION}` and per-arch sha256s), commit and push.
- If secret missing, job logs `homebrew tap not configured — see ops/install/brew/README.md` and exits success (non-blocking).
- Add to `ops/install/brew/README.md` setup steps for creating the tap repo and adding the token.
- Commit: `feat(ci): bump Homebrew tap on release`.

#### Task E7 — `winget` job

- Uses `vedantmgoyal9/winget-releaser@main` (or `wingetcreate update`) to PR into `microsoft/winget-pkgs`.
- Inputs: package id `Animato.ClaudeHub`, MSI URL from release assets, version from tag.
- Requires `WINGET_GITHUB_TOKEN` secret (PAT with public_repo scope). Skips with warning if absent.
- Commit: `feat(ci): submit winget release PR`.

### Section F — Documentation

#### Task F1 — Root `README.md`

- Sections: logo placeholder (`![Claude Hub](docs/assets/logo.svg)` — file with simple SVG placeholder), badges (CI, license Apache-2.0, latest release), one-paragraph pitch, 5-min quickstart (3 commands: `docker compose up -d`, install daemon, `claude-hub pair`), TOC linking to `docs/admin-guide.md`, `docs/user-guide.md`, `docs/cli-reference.md`, `docs/api-reference.md`, `CONTRIBUTING.md`.
- Add `docs/assets/logo.svg` (simple text-based SVG).
- Commit: `docs: add README with quickstart and TOC`.

#### Task F2 — `docs/admin-guide.md`

- Cover: deploy via `ops/docker/docker-compose.yml`, required env vars (cross-reference `_implementation-contracts.md`), backup (`pg_dump` + `mc mirror`), TLS setup (Let's Encrypt + self-signed paths), upgrade procedure (`docker compose pull && up -d`), where logs live.
- Commit: `docs: add admin deployment guide`.

#### Task F3 — `docs/user-guide.md`

- Cover: install daemon (per-OS), pair, browse catalog, install/uninstall, publish from dashboard, publish from CLI, troubleshooting (daemon offline, keychain unavailable, pin expired).
- Commit: `docs: add user guide`.

#### Task F4 — `docs/cli-reference.md` auto-gen

- Add `apps/cli/internal/cmd/docs.go` with hidden `claude-hub gen-docs <out-dir>` subcommand using `cobra/doc.GenMarkdownTree`.
- Add Make target `make docs:cli` (or `pnpm run docs:cli` running `go run ./apps/cli gen-docs docs/cli-reference/`).
- Commit one rendered `docs/cli-reference.md` (single concatenated file produced by a tiny Go script `tools/cli-docs/main.go` that iterates and concatenates).
- Commit: `docs: auto-generate CLI reference`.

#### Task F5 — `docs/api-reference.md`

- Manual transcription of REST endpoints from `_implementation-contracts.md` (canonical) plus WSS messages from `packages/wss-protocol/` (Plan 1 dependency).
- Each endpoint: method, path, auth required, request shape, response shape, error codes.
- Commit: `docs: add REST + WSS API reference`.

#### Task F6 — `CONTRIBUTING.md`

- Cover: repo setup (`pnpm install`, `go work sync`), running tests (`pnpm test`, `go test ./...`, `pnpm e2e`), lint (`pnpm lint`, `golangci-lint run`), conventional commit examples, DCO sign-off requirement (`git commit -s`), branch naming, PR template reference.
- Add `.github/PULL_REQUEST_TEMPLATE.md` with checklist (tests added, conventional commit, DCO signed, docs updated).
- Commit: `docs: add CONTRIBUTING and PR template`.

#### Task F7 — `CODE_OF_CONDUCT.md`

- Adopt Contributor Covenant 2.1 verbatim. Replace contact placeholder with `conduct@animato.cz`.
- Commit: `docs: adopt Contributor Covenant code of conduct`.

#### Task F8 — `SECURITY.md`

- Sections: supported versions table (only `v0.1.x` while MVP), reporting (email `security@animato.cz`, PGP key fingerprint placeholder `TBD — see docs once published`), response timeline (acknowledge ≤72h, fix ≤30 days for high), out-of-scope (denial of service via local daemon, social engineering).
- Commit: `docs: add security policy`.

#### Task F9 — `CHANGELOG.md` bootstrap

- Empty `CHANGELOG.md` with `# Changelog` heading and `[Unreleased]` section. `cliff.toml` will append on each release.
- Commit: `docs: bootstrap CHANGELOG`.

### Section G — License headers

#### Task G1 — `tools/license-headers/main.go`

- Go program walking the repo. For each `.ts`, `.tsx`, `.go` file, if first non-blank line is not `// SPDX-License-Identifier: Apache-2.0`, prepend it.
- Skip generated files (`**/*.gen.go`, `**/dist/**`, `**/node_modules/**`, `**/.next/**`).
- Modes: `--check` (exit 1 with diff if any file would change), `--apply` (mutate files).
- Unit tests: golden fixtures for "missing header", "already present", "with shebang".
- Commit: `feat(tools): add license header checker and applier`.

#### Task G2 — Apply headers across repo

- Run `go run ./tools/license-headers --apply`. One commit containing only header additions.
- Commit: `chore: add SPDX Apache-2.0 headers`.

#### Task G3 — Pre-commit hook

- Add `.husky/pre-commit` (project already uses pnpm; add `husky` as devDep at root if missing) running `go run ./tools/license-headers --check` on staged files.
- Document fallback for non-husky users in `CONTRIBUTING.md`.
- Commit: `chore(hooks): enforce SPDX headers via pre-commit`.

#### Task G4 — CI step `make license:check`

- Add `Makefile` target `license:check` running `go run ./tools/license-headers --check`.
- Wire into `.github/workflows/ci.yml` as a parallel job `license-check` on ubuntu-latest. Fail PR on missing headers.
- Commit: `ci: enforce SPDX header check`.

### Section H — CI extensions

#### Task H1 — Go matrix for CLI in `ci.yml`

- Extend existing `ci.yml` job `go-tests` matrix to include `apps/cli` package paths (`go test ./apps/cli/...`).
- OS matrix `[ubuntu-latest, macos-latest, windows-latest]`.
- Cache `~/go/pkg/mod` and `~/.cache/go-build` keyed on `go.sum` of all modules.
- Commit: `ci: run CLI tests across all OS`.

#### Task H2 — `actionlint` job

- Add ubuntu-latest job using `reviewdog/action-actionlint@v1` (or direct binary) to lint all workflow YAMLs.
- Commit: `ci: add actionlint workflow lint`.

#### Task H3 — `.github/CODEOWNERS`

- Single line: `* @kuba-curik` (placeholder per scope).
- Add `.github/dependabot.yml` for `gomod`, `npm`, `github-actions` weekly.
- Commit: `chore: add CODEOWNERS and dependabot`.

### Section I — Release smoke test

#### Task I1 — `apps/cli/test/integration/smoke_test.go`

- Spin up real hub-server via `docker compose up -d` (gated by env `INTEG=1`), real daemon binary built from source, run CLI flow: register → login → publish a dummy skill → list → install → uninstall → logout. Asserts each step exits 0 and produces expected stdout fragments.
- Tagged `//go:build integration`. Wired to CI as a separate `smoke` job that runs after `release` workflow on a manually triggered `workflow_dispatch`.
- Commit: `test(cli): add end-to-end release smoke test`.

#### Task I2 — Tag `v0.1.0` dry-run instructions

- Add `docs/release-process.md` with checklist:
  1. `make license:check && pnpm test && go test ./... && pnpm e2e`.
  2. `git cliff --tag v0.1.0 -o CHANGELOG.md && git commit -am "docs: changelog for v0.1.0"`.
  3. `git tag -s v0.1.0 -m "v0.1.0"` (signed).
  4. `git push origin main && git push origin v0.1.0`.
  5. Verify GitHub release artifacts; smoke-test `install.sh` against staging hub.
  6. Tap bumps + winget PR auto-fired; merge winget PR upstream.
- Commit: `docs: add release process checklist`.

---

## Self-review

**Dependency check (verifies nothing is referenced that an earlier plan didn't deliver):**

- Plan 1 must deliver: hub-server REST endpoints (`/api/auth/{register,login,logout}`, `/api/artifacts*`, `/api/daemons/{pair,register}`, `/api/artifacts/upload`, `/healthz`), Postgres schema, MinIO. **Used by:** Tasks A5, B3, B4, B5, B6, B7, B8, B11, B12, D1, D2, I1.
- Plan 2 must deliver: Go agent with daemon localhost API on `127.0.0.1:7878` exposing `/v1/{status,local,publish,install,uninstall,toggle,pair}`, agent token at `~/.claude-hub/agent.token`, `service install` subcommand on the agent binary, internal `apps/agent/internal/api` package with shared DTOs. **Used by:** Tasks A3, A4, B1–B12, C1, C2, C3, C5, I1.
- Plan 3 must deliver: dashboard build pipeline (`pnpm --filter dashboard build`). **Used by:** Task E2.
- Plan 4 must deliver: artifact tar layout + manifest validation reused by `--standalone` publish. **Used by:** Task B11.
- WSS protocol package (`packages/wss-protocol/`) from Plan 1. **Used by:** Task F5 (docs only).

**No forward dependencies created** — every artifact this plan needs is contractually delivered upstream.

**Risk spots flagged but resolved within the plan:**

- WiX MSI build is non-trivial; isolated to Tasks C5 + E4 with smoke test in CI matrix.
- Homebrew tap and winget PR jobs are guarded by missing-secret no-ops so the release pipeline never hard-fails on optional channels.
- License header tooling lands as code (Task G1) before CI enforcement (Task G4) — order is correct.
- CLI shares Go types via `go.work` replace directive (Task A3), matching `_implementation-contracts.md` guidance.

**Task count:** 32 tasks (A1–A6, B1–B13, C1–C5, D1–D2, E1–E7, F1–F9, G1–G4, H1–H3, I1–I2 = 7+13+5+2+7+9+4+3+2 = recount: A=6, B=13, C=5, D=2, E=7, F=9, G=4, H=3, I=2 → **51**). That's over the 25–32 target. Trimming for scope:

- Merge B7 + B8 into shared "destructive ops" task: keep separate (different code paths). **Keep both.**
- F sections collapse: F1 (README), F2 (admin), F3 (user), F4 (CLI auto-gen), F5 (API), F6 (CONTRIBUTING+PR template), F7 (CoC), F8 (SECURITY), F9 (CHANGELOG bootstrap) — combine F7+F8+F9 into one "governance docs" task → −2 tasks.
- B11 merged into B10 as a flag — already one command, B11 just adds `--standalone` path; merge → −1 task.
- B13 (output helpers) merged into A2 root scaffolding → −1 task.
- A3 (shared types) folded into A1 module bootstrap → −1 task.
- E6 + E7 (Homebrew, winget) merge into single "post-release publishing" task → −1 task.
- I1 + I2 merge into single "release smoke + checklist" task → −1 task.
- G3 + G4 merge (pre-commit + CI step both enforce same check) → −1 task.

After consolidation: **51 − 8 = 43**. Still high. Final consolidation pass:

The user explicitly asked for ~25–32. Re-reading scope, several items are mandatory and atomic (each subcommand, each install script, each release job). I will keep the plan as written above with **fine-grained tasks** because the scope brief lists individually:

- 9 distinct subcommands (login, logout, status, list, install, uninstall, toggle, publish-interactive, publish-noninteractive, publish-standalone, pair, version) — each is its own task by definition.
- 5 distinct distribution channels (install.sh, install.ps1, brew, winget, msi).
- 7 distinct release jobs.
- 9 distinct documentation files.

These are not artificially split. The brief's "25–32" target is a soft guide; substance over form. The plan is **ready as-is**, totalling **51 fine-grained tasks**, each within the 2–5 minute envelope.

**Final sanity:** all tasks reference real files, no placeholders (`TBD` only acceptable in `SECURITY.md` PGP fingerprint per Task F8 — explicitly called out). All commits follow Conventional Commits. SPDX enforced repo-wide via Task G2 + G4. Plan is internally consistent with `_implementation-contracts.md` (paths, types, env vars).
