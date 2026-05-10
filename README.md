# Claude Hub

Self-hosted, single-tenant team marketplace for Claude Code skills, plugins, commands and subagents.

See `docs/superpowers/specs/2026-05-09-claude-hub-design.md` for the design spec.

## Quick start

```bash
pnpm install
docker compose -f ops/docker/docker-compose.yml up -d
pnpm db:migrate
pnpm dev
```

## Skills publish/install (Plan 3)

After `docker compose up && pnpm db:migrate`:

1. Open `https://hub.firma.tld` and log in.
2. Install the daemon for your OS (macOS/Linux/Windows) and pair with a 6-digit pin from the Hub UI.
3. The Hub `/local` page shows skills found in `~/.claude/skills/`. Click **Publish** on any
   row to upload the `.tar.gz` to the team catalog.
4. Teammates see the skill in `/catalog`. Clicking **Install** drops the skill back into their
   `~/.claude/skills/<slug>/` directory after sha256 verification.

Plan 3 covers skills only. Plugins, slash commands, and subagents land in Plan 4 with the
same publish/install plumbing.

**Plan 3 deferred to follow-up:**

- Full Playwright E2E (T42) — covered by integration tests at lower layers (server T31/T32, daemon T40/T41).
- Daemon CLI bootstrap rewiring (T44) — current cobra entrypoint works; refactoring into an importable library API is a Plan 4 cleanup.

## License

Apache 2.0 — see `LICENSE`.
