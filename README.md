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

## License

Apache 2.0 — see `LICENSE`.
