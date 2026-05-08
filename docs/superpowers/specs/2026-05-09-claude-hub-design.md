# Claude Hub — Design Spec

**Date:** 2026-05-09
**Status:** Approved
**Owner:** Kuba Curik (curik@animato.cz)
**License:** Apache 2.0

## 1. Summary

Claude Hub is a self-hosted, single-tenant team dashboard for Claude Code that lets a company share Skills, Plugins, Slash Commands, and Subagents across team members with one-click publish/install. It runs as a Docker stack on the company's infrastructure; each user installs a small local agent (daemon) that bidirectionally syncs the user's `~/.claude/` state with the hub's web dashboard.

The product fills a real market gap: existing tooling (Concord, skillshare, CCPI, Continue Hub, Anthropic marketplaces) covers either IaC-style sync, public registries, or multi-tool federation — but not a lightweight team-internal marketplace with a live dashboard view of "what each member has locally" and one-click publish/install.

## 2. Goals and non-goals

### 2.1 Goals (v1.0 / MVP)

- Frictionless onboarding: a new team member runs one install + one pin → all team artifacts are discoverable and installable from a web UI.
- Bidirectional dashboard: the user sees everything they have locally (with active/disabled state) and everything the team has shared.
- Publish from web UI by clicking on a local artifact, or from CLI for power users / CI.
- Cross-platform daemon: Windows, macOS, Linux.
- Single-tenant per company: one Docker deployment serves one organization.
- Local accounts (e-mail + password) auth; admin and member roles.
- Immutable semver versioning for published artifacts.

### 2.2 Non-goals (deferred)

- MCP servers and Hooks sharing — deferred to v1.1 because they execute code or carry secrets and require a permissions model + signing/review.
- Settings.json and CLAUDE.md sharing — hierarchy and per-user secrets make these a poor MVP fit.
- Project-level scope (`.claude/` in a repo) — v1.2.
- Multi-tenant SaaS — v2.0 opt-in.
- 2FA / SSO / OIDC — v2.x.
- Code signing, supply-chain provenance — later.
- Cross-tool sync (Codex, Cursor) — out of scope; this product is Claude Code-specific.

## 3. Positioning

Among existing tools:

- **Concord** is IaC/admin-heavy with manifest+lockfile semantics — strong for governance, weak for ad-hoc sharing.
- **skillshare** does multi-tool one-shot sync — strong for personal dotfiles, no team registry.
- **CCPI** is a public npm-style registry — covers discovery but not "what does my team have".
- **Continue Hub** is the closest peer in spirit, but multi-tool and centralized.
- **Anthropic native** (`marketplace.json`, `extraKnownMarketplaces`, Cowork) covers public marketplaces and "trust this folder" auto-install but not the live "see your team's state" dashboard or in-team publishing flow.

Claude Hub is positioned as **the team-internal marketplace with a live dashboard**. Its differentiator is the always-running local daemon plus web dashboard that shows local + team state in real time.

## 4. Architecture

### 4.1 High-level diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                  User machine (Win/Mac/Linux)                    │
│                                                                  │
│   ┌────────────────────┐         ┌──────────────────────┐       │
│   │  Claude Code CLI   │ <─────> │  ~/.claude/          │       │
│   │  (reads settings)  │         │  ├ skills/           │       │
│   └────────────────────┘         │  ├ plugins/          │       │
│                                  │  ├ commands/         │       │
│   ┌────────────────────┐         │  ├ agents/           │       │
│   │  claude-hub-agent  │ <─────> │  └ settings.json     │       │
│   │  (Go daemon)       │         └──────────────────────┘       │
│   │  - file watcher    │                                        │
│   │  - manifest parser │                                        │
│   │  - localhost API   │                                        │
│   │  - WSS client      │                                        │
│   └─────────┬──────────┘                                        │
│             │ WSS over TLS, device token                        │
└─────────────┼───────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Hub server (company self-hosts Docker)              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  hub-server (Node.js + TypeScript, Hono)                 │   │
│  │  ├ /api/*    REST  (auth, publish, install, list)        │   │
│  │  ├ /ws       WebSocket (daemon ↔ server, dashboard ↔ srv)│   │
│  │  └ /         Next.js dashboard (SSR)                     │   │
│  └─────────────────────┬────────────────────────────────────┘   │
│                        │                                         │
│  ┌──────────────┐   ┌──┴──────────┐                             │
│  │  Postgres    │   │   MinIO      │                            │
│  │  (catalog,   │   │  (artifact   │                            │
│  │   users,     │   │   .tar.gz)   │                            │
│  │   audit)     │   └──────────────┘                            │
│  └──────────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Components

1. **`claude-hub-agent`** — Go daemon installed on each user machine.
   - Filesystem watcher over `~/.claude/{skills,plugins,commands,agents}` using `fsnotify`.
   - Manifest parser for skill frontmatter, `plugin.json`, command/agent files.
   - Local HTTP API on `127.0.0.1:7878` for the CLI (`status`, `local`, `publish`, `install`).
   - Persistent WSS client to the hub server for inventory push and command receive.
   - Service installation via `kardianos/service` (Windows service / macOS launchd / Linux systemd).

2. **`hub-server`** — Node.js + TypeScript + Hono.
   - REST API: `/api/auth`, `/api/artifacts/{publish,install,list,detail}`, `/api/users`, `/api/daemons`.
   - WebSocket gateway: two client kinds — daemons (push inventory, receive jobs) and dashboard sessions (subscribe to own daemon's inventory).
   - Serves the Next.js dashboard at `/`.

3. **`hub-dashboard`** — Next.js 14+ App Router, Tailwind, shadcn/ui.
   - Sections: Login, Local view (live), Team catalog, Publish wizard, Settings (admin).

4. **Postgres** — catalog, users, sessions, audit. Single-tenant; no row-level multi-tenancy in MVP.

5. **MinIO** — S3-compatible object storage for artifact `.tar.gz` blobs and `manifest.json` sidecars.

6. **Optional Redis** — not in MVP. Ephemeral state lives in hub-server memory; horizontal scaling out of scope until v2.

### 4.3 Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Daemon | Go + `fsnotify` + `kardianos/service` | Single ~10 MB static binary per OS, no runtime deps, instant cross-compile. |
| Hub server | Node.js 22 + TypeScript + Hono | Modern, lightweight, large ecosystem, type sharing with frontend. |
| Database | PostgreSQL 16 | Production-grade, JSONB for manifests, full-text search ready. |
| Frontend | Next.js + Tailwind + shadcn/ui | Industry standard for dashboards, SSR for SEO landing. |
| Auth library | Lucia or BetterAuth | TypeScript-native, password+session. Final pick during impl. |
| Object storage | MinIO | S3-compatible, self-hostable, ships in docker-compose. |
| Daemon ↔ hub | WSS for control + REST for blobs | Real-time UX where it matters; REST for large uploads. |

## 5. Data model

### 5.1 Postgres schema (MVP)

```sql
users (
  id UUID PK, email TEXT UNIQUE, password_hash TEXT,
  name TEXT, role TEXT CHECK (role IN ('admin','member')),
  created_at TIMESTAMPTZ, last_login_at TIMESTAMPTZ
)

sessions (
  id UUID PK, user_id UUID FK, token TEXT UNIQUE,
  expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ
)

daemons (
  id UUID PK, user_id UUID FK, hostname TEXT,
  os TEXT CHECK (os IN ('windows','macos','linux')),
  agent_version TEXT, paired_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ
)

artifacts (
  id UUID PK, slug TEXT UNIQUE,
  type TEXT CHECK (type IN ('skill','plugin','command','agent')),
  description TEXT, owner_user_id UUID FK,
  created_at TIMESTAMPTZ, archived_at TIMESTAMPTZ
)

artifact_versions (
  id UUID PK, artifact_id UUID FK,
  version TEXT, storage_key TEXT, sha256 TEXT,
  manifest JSONB, published_by_user_id UUID FK,
  published_at TIMESTAMPTZ, deprecated BOOLEAN DEFAULT false,
  UNIQUE(artifact_id, version)
)

install_events (
  id UUID PK, daemon_id UUID FK, artifact_version_id UUID FK,
  installed_at TIMESTAMPTZ,
  status TEXT CHECK (status IN ('success','failed','rolled_back'))
)

audit_log (
  id UUID PK, actor_user_id UUID FK, action TEXT,
  target_type TEXT, target_id TEXT, payload JSONB,
  created_at TIMESTAMPTZ
)
```

### 5.2 Ephemeral state (hub-server memory)

- `Map<daemonId, Inventory>` — what the daemon reports as locally present. Pushed on connect and on changes. Lost on hub-server restart; daemons re-push on reconnect.
- `Map<daemonId, WebSocket>` — active connections.

### 5.3 Key decisions

- Manifests are denormalized into `artifact_versions.manifest` (JSONB) so the catalog can render without fetching `.tar.gz`.
- Versioning is immutable semver. Yank uses `deprecated=true`; the version row and blob remain so older installs can still be reproduced. "Latest" = max non-deprecated semver.
- Local inventory is **not** persisted to Postgres. It is a real-time stream (daemon → hub → dashboard) and re-derivable on reconnect.
- `storage_key` convention: `artifacts/{artifact_id}/{version}.tar.gz` plus a sibling `manifest.json` for fast meta fetch.
- RBAC is minimal in MVP: `admin` (everything + user mgmt + force-yank) and `member` (publish/install own + own-yank).

## 6. User flows

### 6.1 Bootstrap a company instance

```
Admin:
1. docker compose up -d                      # hub-server + postgres + minio
2. Open https://hub.company.tld
3. Setup wizard creates the root admin account
4. Generate invite link, share with the team
```

### 6.2 Onboard a new member

```
1. Click invite link → register (e-mail + password + name)
2. Dashboard banner: "Your daemon is not paired yet" + per-OS install:
   • macOS:    brew install claude-hub-agent
   • Linux:    curl https://hub.company.tld/install.sh | sh
   • Windows:  iwr https://hub.company.tld/install.ps1 | iex
3. After install the daemon is running (autostart enabled)
4. Hub UI shows a 6-digit pin (TTL 5 min)
5. CLI: claude-hub-agent pair --hub https://hub.company.tld --pin 482913
6. Daemon opens WSS → server validates pin → server returns
   device_token → daemon stores it in OS keychain
   (Windows Credential Manager / macOS Keychain / libsecret)
7. Daemon scans ~/.claude/ → pushes inventory over WSS
8. Dashboard "Local" tab populates live
```

### 6.3 Publish from the dashboard

```
1. "Local" tab lists skills/plugins/commands/agents found locally,
   each row with [Publish] button.
2. Click [Publish] → modal:
   • Slug, Version (default = next semver), Description (from manifest), Type (auto)
3. Submit:
   a. Hub → daemon (WSS): "package-and-upload artifact X"
   b. Daemon: tar -czf, sha256, POST /api/artifacts/upload (REST,
      not WS, due to payload size)
   c. Hub: validate → MinIO → INSERT artifact + artifact_version
   d. Hub broadcasts "new version" → other dashboards refresh
   e. UI: "Published as skill:my-helper@0.1.0"
4. audit_log row written
```

### 6.4 Publish from CLI (interactive)

```
$ claude-hub publish
? What do you want to publish? (browses local inventory)
  ❯ skill:    my-helper      ~/.claude/skills/my-helper/
    plugin:   org-tooling     ~/.claude/plugins/org-tooling/
    command:  /deploy          ~/.claude/commands/deploy.md
? Version: (0.1.0)
? Description: (from manifest) ...
✓ Packaging... uploading 47 KB...
✓ Published: skill:my-helper@0.1.0
```

CLI calls the local daemon at `127.0.0.1:7878/publish`; the daemon does the same work as a UI-driven publish.

### 6.5 Install from the dashboard

```
1. "Team catalog" → click artifact → [Install]
2. Hub → daemon (WSS): "install artifact_version_id=N"
3. Daemon: GET .tar.gz from hub, verify sha256, extract into ~/.claude/...
4. Daemon: push updated inventory
5. UI shows the artifact in "Local"
6. install_event row written
```

### 6.6 Enable / Disable (MVP scope)

| Type | Toggle in MVP | Mechanism |
|---|---|---|
| Plugin | yes | `settings.json → enabledPlugins[name] = bool` |
| Skill | no (no native flag) | Disable = uninstall |
| Command | no | Disable = uninstall |
| Subagent | no | Disable = uninstall |

Dashboard renders a toggle only where it is meaningful; otherwise [Uninstall].

### 6.7 Offline daemon

- Hub stamps `last_seen_at` on disconnect. Dashboard banner: "Your daemon is offline".
- UI actions (Publish/Install/Toggle) require an online daemon → buttons are disabled with a tooltip in MVP. Job queueing comes later.
- CLI `login` and `list` work without a daemon (REST-only). `publish`/`install` require either the daemon or a `--standalone` fallback that talks to the hub directly.

## 7. Security

### 7.1 Threat model

| Threat | MVP mitigation | Later |
|---|---|---|
| Credential theft | Argon2id (m=64MB, t=3, p=4), min 12-char passwords, login rate-limit 5/15min/IP+email | TOTP 2FA |
| MitM daemon ↔ hub | TLS everywhere; daemon validates hub cert; pin TLS fingerprint inside `device-token` envelope | Cert rotation flow |
| Device token theft | Token in OS keychain, never plaintext on disk | Periodic device-token rotation |
| Malicious team artifact (insider) | sha256 + immutable versions + audit log + admin yank | Sigstore-style code signing, mandatory review |
| Compromised hub pushing malware | Daemon verifies sha256 on download; daemon never executes downloaded code (copies files only) | Reproducible builds, signed manifests |
| MinIO blob tampering | Postgres `sha256` is the source of truth; daemon re-verifies | Server-side encryption-at-rest |
| Cross-user data leak | RBAC checks on every endpoint; integration tests for the auth boundary | — |

### 7.2 User auth

- Argon2id password hashing (memory 64 MB, iterations 3, parallelism 4).
- 256-bit opaque session tokens in HttpOnly Secure SameSite=Lax cookies; server-side `sessions` row.
- Logout invalidates the row.
- Login rate limit: 5 failed attempts per 15 min per (IP, email).

### 7.3 Daemon pairing

1. Logged-in user clicks "Pair daemon" → `POST /api/daemons/pair` → server returns 6-digit pin + `pairing_id`, TTL 5 min, kept in an ephemeral pairings table.
2. User runs `claude-hub-agent pair --hub <url> --pin <pin>`.
3. Daemon: `POST /api/daemons/register` with the pin and machine metadata (hostname, OS, agent_version) → server validates the pin → returns 256-bit `device_token` + `daemon_id`.
4. Daemon stores them in OS keychain.
5. WSS connect: `Authorization: Bearer <device_token>`.

### 7.4 Token strategy

- `session_token` — user, browser cookie, short TTL (refreshed on activity).
- `device_token` — daemon, machine-bound, long TTL.
- No JWT — opaque tokens + DB lookup. Trivial revocation by deleting the row.

### 7.5 RBAC matrix

| Action | member | admin |
|---|---|---|
| Login, view catalog, install, view own local | yes | yes |
| Publish | yes | yes |
| Yank own artifacts | yes | yes |
| Yank other users' artifacts | no | yes |
| Manage users (invite, role, deactivate) | no | yes |
| View audit log | no | yes |
| Server settings | no | yes |

Implementation: `requireRole('admin')` middleware on admin endpoints. Integration tests verify a `member` token receives 403.

### 7.6 Daemon-side hardening

- Daemon writes only inside `~/.claude/` (whitelist, hardcoded prefix, reject `..` in `storage_key`).
- Daemon never executes downloaded code on install — it only copies files. Execution is delegated to Claude Code, the sandboxed harness.
- Hooks are deferred specifically because shell-script sharing without review is unacceptable.
- Local HTTP API binds to `127.0.0.1` only; CORS deny by default.
- Local API requires a file token at `~/.claude-hub/agent.token` (mode 0600), preventing arbitrary local processes from talking to the daemon.

### 7.7 Artifact integrity

- On publish: daemon computes sha256 of the `.tar.gz`, sends it in the REST request; server re-verifies after receive.
- sha256 is stored in `artifact_versions` and copied into the sidecar `manifest.json` in MinIO. Postgres is the source of truth.
- On install: daemon downloads, recomputes sha256, compares to the value carried in the install job; mismatch aborts and writes an audit alert.
- Versions are immutable; once published, the checksum cannot change.

### 7.8 Operational secrets

- Hub server reads DB password, MinIO access keys, and session signing key from a `.env` file that is mounted, not baked into the image. In production, prefer Docker secrets or Kubernetes Secret. Setup wizard generates them on first run.
- Daemon stores its device token in OS keychain; nothing on disk in plaintext.
- TLS: setup wizard offers Let's Encrypt for public domains and self-signed for intranet (with instructions for trusting the cert on clients).

## 8. Testing strategy

| Layer | Test type | Tooling |
|---|---|---|
| Hub server core (auth, RBAC, models) | Unit | Vitest |
| API endpoints | Integration vs real Postgres + MinIO | Vitest + Testcontainers |
| Daemon (parser, watcher, sync) | Unit | Go `testing` + mocked `fsnotify` |
| Daemon ↔ hub | Integration vs `httptest` server | Go testing |
| Web flows (register, pair, publish, install) | E2E | Playwright |
| Cross-platform daemon | CI matrix | GitHub Actions |
| Security boundary (RBAC, path traversal, sha256) | Dedicated security tests | Vitest + curated payloads |

Rules:
- No unit test mocks the database — Testcontainers + real Postgres.
- Daemon CI builds and tests on Win/Mac/Linux for every PR.
- Smoke test `docker-compose up && playwright test` runs in CI before any release.

## 9. Roadmap

| Version | Scope | Goal |
|---|---|---|
| v1.0 MVP | This spec | Frictionless team-internal marketplace |
| v1.1 | MCP servers + Hooks with permissions, review queue, signing | Safe executable artifacts |
| v1.2 | Project-level scope (`.claude/` in repo) | Per-project sharing |
| v1.3 | Search, tags, categories, popularity | Better discovery |
| v1.4 | External marketplace federation (anthropics/claude-plugins-official, CCPI) | Single pane of glass |
| v2.0 | Multi-tenant (multiple companies on one instance) | Optional SaaS posture |
| v2.x | 2FA, SSO/OIDC, skill effectiveness telemetry, audit dashboards | Enterprise readiness |

## 10. Open questions (for implementation phase)

1. **Slug collisions**: a member already has a local skill `helper` and a teammate publishes `helper`. Proposal: hub-wide unique slugs, so the second publish fails with "slug taken"; on install, prompt the user that the local unpublished version will be overwritten.

2. **Project-level plugins and `cwd`-aware daemon**: MVP scans only user-level (`~/.claude/`). Project-level (`<repo>/.claude/`) lands in v1.2; how the daemon detects which project the user is currently working on (last-CWD heuristic vs explicit `claude-hub project add` registration) is the open part.

3. **Daemon ahead of hub schema**: WSS handshake exchanges versions; hub rejects incompatible major versions. Strict semver for the WSS protocol itself.

4. **Branding and domain**: product name and whether to use `claude-hub.io`, `clamp.dev`, or another. Anthropic owns the "Claude" mark; phrase as "... for Claude Code" to stay safe.

5. **Future signatures**: not in MVP, but reserve `manifest.signatures[]` so Sigstore can be added without a schema break.

6. **Backup / export**: ship `claude-hub backup` CLI (tar.gz of `pg_dump` + `mc mirror` of MinIO) or document the steps.

## 11. Resolved decisions

- **License**: Apache 2.0 — permissive, includes patent grant, is the de facto standard for developer infrastructure tools, and removes adoption friction for companies. Captured in `LICENSE` at repo root and `SPDX-License-Identifier: Apache-2.0` headers in source files.
