# Claude Hub

Claude Hub is a team catalog for Claude Code assets. It is intentionally not a
forced sync tool: teammates publish useful skills, commands, MCP servers, hooks,
plugins, and presets, while each user chooses what to install, enable, disable,
update, or publish from their local Claude Code setup.

## Architecture

```text
apps/web        Next.js web catalog and local-state UI
apps/api        TypeScript/Fastify registry API backed by Postgres
apps/daemon     Go local daemon for Claude Code filesystem operations
packages/schema Shared TypeScript contracts and JSON Schema
docs            Product and architecture notes
```

The browser never touches the filesystem. It talks to the Go daemon on
`127.0.0.1`, and the daemon performs local Claude Code operations after returning
an install preview.

## Development

Install dependencies:

```bash
npm install
```

Start a local Postgres database, then run the services in separate terminals:

```bash
docker compose up postgres
set CLAUDE_HUB_DATABASE_URL=postgres://claude_hub:claude_hub@127.0.0.1:5432/claude_hub
```

Run the services in separate terminals:

```bash
npm run dev:api
npm run dev:web
npm run dev:daemon
```

Default URLs:

- web app: http://localhost:3000
- registry API: http://127.0.0.1:8787
- local daemon: http://127.0.0.1:17373

The daemon prints a pairing token. Paste it into the web app to connect the
catalog to this computer. The web app requires an email login before catalog
access; the local daemon token stays on the device and only a hashed device
pairing is sent to the Hub API.

To make the web app read from the API instead of its local fallback catalog:

```bash
set CLAUDE_HUB_API_URL=http://127.0.0.1:8787
set CLAUDE_HUB_PUBLIC_URL=https://hub.animato-lab.cz
set CLAUDE_HUB_DAEMON_WINGET_ID=Animato.ClaudeHubDaemon
set CLAUDE_HUB_DAEMON_BREW_PACKAGE=animato-lab/tap/claude-hub-daemon
npm run dev:web
```

For a production Hub domain, the locally installed daemon must allow that web
origin:

```bash
set CLAUDE_HUB_ALLOWED_WEB_ORIGINS=https://hub.animato-lab.cz
claude-hub-daemon
```

The web app still talks to the daemon at `http://127.0.0.1:17373`. The daemon
does not accept arbitrary websites; it only allows localhost development origins
and origins listed in `CLAUDE_HUB_ALLOWED_WEB_ORIGINS`.

## Docker Desktop

The Docker setup connects the daemon to your real Claude Code home and to your
workspace root:

```text
%USERPROFILE%\.claude
D:\Claude
```

This is useful for realistic testing because the web app can show your actual
user-level skills, commands, hooks, MCP configs, and plugins, plus project-level
assets from `.claude` folders such as `D:\Claude\creado-web\.claude`. Install,
enable, and disable actions can write to your Claude Code home, so review the
daemon preview before confirming changes. Publishing a local item writes it
directly to the shared Postgres-backed catalog.

If your workspaces live somewhere else, set `CLAUDE_HUB_WORKSPACE_ROOT_D` before
starting Docker Compose. The container scans that root for project `.claude`
directories.

Run everything:

```bash
npm run docker:up
```

Open:

- web app: http://localhost:3100
- registry API: http://localhost:8787/health
- local daemon: http://localhost:17373/v1/hello
- Postgres: localhost:5432

Get the daemon pairing token:

```bash
docker compose logs daemon
```

Paste the `Pairing token` value into the web app.

Stop the stack:

```bash
npm run docker:down
```

## Verification

```bash
npm run typecheck
npm run build
npm test
```

## Current Scope

Implemented:

- Next.js catalog UI with local daemon pairing
- email login, logout, HTTP-only web session cookie, and paired-device metadata
- Czech web UI for catalog browsing and local publishing
- server-side registry API client with local fallback data
- TypeScript/Fastify registry API with Postgres-backed catalog endpoints
- Go daemon with authenticated localhost API
- local detection of user-level Claude Code skills, commands, `settings.json`
  hooks, MCP configs, and installed plugins
- local detection of project-level skills, commands, hooks, MCP configs, and
  plugins under real workspace `.claude` folders
- install preview, install, enable, disable, and direct local-to-catalog publish
  flows
- Go tests for the daemon asset manager
- Postgres integration test for catalog persistence

Next:

- full team membership and invitations
- signed packages and package hash verification
- high-risk MCP, hook, and plugin installation policies
- configurable workspace root management from the web UI
