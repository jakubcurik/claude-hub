# Claude Hub Product Plan

## Product Definition

Claude Hub is a Czech web catalog for team-shared Claude Code assets. It is not a
mandatory sync tool. Users browse what teammates have shared and choose what to
install, enable, disable, update, or publish from their local Claude Code setup.

The product promise:

> A teammate can publish a useful Claude Code asset once, and everyone else can
> discover it in a friendly web UI, see whether they already have it locally, and
> install or enable it without manual setup instructions.

## Core Principles

- The user stays in control. Avoid language and behavior that implies forced
  synchronization.
- The web app is the primary experience. The daemon is only a local bridge.
- Every local write needs a preview.
- Secrets never leave the user's machine unless the user explicitly confirms
  publishing after seeing warnings.
- Local changes must be visible instead of silently overwritten.
- The catalog is persisted in Postgres.

## Architecture

```text
Web App
  |
  | HTTP API in local Docker, HTTPS API in hosted deployments
  v
Registry API
  |
  | catalog metadata and package content
  v
Postgres

Web App
  |
  | authenticated localhost API
  v
Local Daemon
  |
  | reads and writes local Claude Code files
  v
Claude Code local environment
```

## MVP

The first implementation proves the complete local loop:

1. Web catalog shows shared assets from Postgres.
2. Local daemon pairs with the web app.
3. Web app displays local state for each catalog item.
4. User previews install changes.
5. User installs, enables, disables, or updates a supported catalog item.
6. User can upload a local asset directly into the shared catalog.
7. User can filter local assets by type.

## UX Model

Primary navigation:

- Katalog
- Moje Claude Code

Catalog item states:

- Není nainstalováno
- Zapnuto
- Vypnuto
- Dostupná aktualizace
- Lokální změny
- V plánu

Primary actions:

- Nainstalovat
- Aktualizovat
- Zapnout
- Vypnout
- Nahrát do katalogu

Avoid the word "sync" for primary actions because it suggests that the team is
pushing changes onto the user.

## Security Model

Local daemon:

- listens only on `127.0.0.1` by default
- requires a pairing token
- accepts requests only from local browser origins
- returns previews before writes
- stores rollback data locally
- exports only text assets that pass size and UTF-8 checks
- exports only the `hooks` section when sharing hooks from `settings.json`

Risk levels:

- Low: skills and plain prompt assets
- Medium: commands and config assets
- High: MCP servers, hooks, plugins, or anything that executes code

## Later Phases

1. Auth, teams, users, packages, and versions.
2. MCP server support with env setup and permission previews.
3. Hook and plugin support with stronger policy checks.
4. Signed manifests and package hashes.
5. Collections such as frontend workflow and onboarding kits.
6. Usage signals such as used by teammates, stale versions, and recommended
   assets.
