# Produkční nasazení

Tento dokument popisuje, jak nasadit Claude Hub do reálného prostředí. Pokrývá registry API, webovou aplikaci, Postgres a distribuci lokálního daemonu.

## Topologie

```
                       Internet
                          │
                          ▼
                  ┌────────────────┐
                  │   HTTPS proxy  │  nginx / Caddy / Traefik (TLS termination)
                  └───────┬────────┘
                ┌─────────┴──────────┐
                ▼                    ▼
        ┌────────────┐        ┌────────────┐
        │  web app   │        │ registry   │
        │ (Node 22)  │───────▶│   API      │
        └────────────┘        └─────┬──────┘
                                    ▼
                              ┌───────────┐
                              │ Postgres  │
                              └───────────┘

      (Daemon žije na uživatelských zařízeních, viz "Distribuce daemonu" níže.)
```

Doporučená separace:

- **web** a **api** jsou stateless — provozujte je v Docker / Kubernetes / Fly.io / Render bez problémů.
- **Postgres** musí být perzistentní s pravidelnými zálohami.
- **TLS termination** patří na proxy, nikoli do Node procesů — Fastify ani Next.js v produkci nemají dělat HTTPS přímo.

## Postgres

Verze: PostgreSQL 16+. Tabulky se vytvářejí automaticky při startu API, ale doporučuji spravovat schéma migracemi (např. `node-pg-migrate` nebo `dbmate`) jakmile produkt zraje.

**Připravte zálohu:**

```bash
# denní pg_dump
pg_dump --format=custom --no-owner claude_hub > /backups/claude_hub-$(date +%F).dump

# PITR přes WAL archivaci (doporučeno pro produkci)
archive_command = 'wal-g wal-push %p'
```

**Sledování:**

- velikost `catalog_asset_versions` (roste donekonečna — později plánovaný retention),
- velikost `catalog_events` (audit log, doporučeno čistit starší než 1 rok),
- aktivní spojení (`pg_stat_activity`).

## Registry API

Doporučené proměnné prostředí pro produkci:

```bash
CLAUDE_HUB_API_HOST=0.0.0.0
CLAUDE_HUB_API_PORT=8787
CLAUDE_HUB_DATABASE_URL=postgres://claude_hub:HESLO@db.internal:5432/claude_hub
CLAUDE_HUB_SESSION_CLEANUP_INTERVAL_MS=3600000
NODE_ENV=production
```

Spuštění:

```bash
node apps/api/dist/server.js
```

CORS v `apps/api/src/server.ts` v default módu povoluje pouze `localhost`. Pro produkční web doménu doplňte v kódu:

```ts
await app.register(cors, {
  origin: [
    /^http:\/\/localhost:\d+$/,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    "https://hub.example.com"
  ]
});
```

## Web aplikace

Build a start:

```bash
npm --workspace @claude-hub/web run build
npm --workspace @claude-hub/web run start
```

Produkční env (typický):

```bash
NODE_ENV=production
CLAUDE_HUB_API_URL=https://api.hub.example.com
CLAUDE_HUB_PUBLIC_URL=https://hub.example.com
CLAUDE_HUB_DAEMON_BREW_PACKAGE=animato-lab/tap/claude-hub-daemon
CLAUDE_HUB_DAEMON_WINGET_ID=Animato.ClaudeHubDaemon
```

> **Pozor:** Web aplikace volá daemonové API z prohlížeče přímo na `http://127.0.0.1:17373`. Pro povolení produkční domény jako origin musí mít každý uživatel daemon spuštěný s `CLAUDE_HUB_ALLOWED_WEB_ORIGINS=https://hub.example.com`.

### Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name hub.example.com;

    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    server_name api.hub.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.hub.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Distribuce daemonu

Daemon je single static binárka. Release pipeline využívá **goreleaser** (konfigurace v `.goreleaser.yaml`, GitHub Actions workflow v `.github/workflows/release.yml`):

### Lokální dry-run

```bash
./scripts/release-snapshot.sh
```

Vytvoří snapshot release v `dist/` bez nahrání na GitHub. Vhodné na ověření buildu před skutečným tagem.

### Skutečný release

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Action zařídí cross-compile, archivaci, vytvoření GitHub Release, push do Homebrew tap a Scoop bucket repozitářů.

### Winget

Manifesty v `packaging/winget/` (3 soubory: `installer.yaml`, `locale.cs-CZ.yaml`, root version manifest). Po vytvoření release:

1. Stáhněte ZIP s Windows amd64 binárkou.
2. Spočítejte SHA256.
3. Vyplňte `${VERSION}`, `${URL_WINDOWS_AMD64}`, `${SHA256_WINDOWS_AMD64}`, `${RELEASE_DATE}` v manifestech.
4. PR do `microsoft/winget-pkgs` pod cestou `manifests/a/Animato/ClaudeHubDaemon/<version>/`.

Workflow `release.yml` zatím tento krok pouze připomíná — automatický wingetcreate fork & PR je možný (`vedantmgoyal2009/winget-releaser`), ale vyžaduje GitHub token s patřičným scopem.

## Bezpečnostní checklist před go-live

- [ ] TLS všude (API i web, ne self-signed).
- [ ] `CLAUDE_HUB_DATABASE_URL` mimo VCS — secret manager.
- [ ] Postgres role `claude_hub` má jen práva na vlastní DB, žádné `SUPERUSER`.
- [ ] PG zálohy ověřené restorem (alespoň jednou před spuštěním).
- [ ] Rate-limit na `/v1/auth/login` aktivní (kontrola v logu).
- [ ] CORS allowlist drží jen produkční doménu.
- [ ] `CLAUDE_HUB_ALLOWED_WEB_ORIGINS` v binárce daemonu nebo v instalátoru.
- [ ] Monitoring `/health` (Uptime Robot / Pingdom / interní).
- [ ] Log retention podle interních pravidel (audit `catalog_events`).
- [ ] CSP hlavička přes proxy (`default-src 'self'`).
- [ ] `X-Frame-Options: DENY` (web aplikace nepoužívá iframy).

## Plán DR

| Scénář                             | Akce                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| Pád Postgresu                       | Restore z `pg_dump` nebo PITR z WAL archivu, restart API.            |
| Kompromitovaný API server           | Rotace všech `hub_sessions` (`TRUNCATE`), force re-login uživatelů. |
| Únik daemonského tokenu uživatele   | Smazat `daemon-token`, restart daemonu (vygeneruje nový), revoknout `paired_devices` v API. |
| Špatně publikovaný asset            | `SELECT FROM catalog_asset_versions` → restore předchozí verze do `catalog_assets`. |
