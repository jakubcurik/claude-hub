# Registry API

HTTP rozhraní služby `apps/api`. Postaveno na Fastify 5, autentizace probíhá přes Bearer session tokeny vydávané `POST /v1/auth/login`. Veškerá data jdou přes Postgres (`RegistryRepository`).

Base URL ve výchozím dev prostředí: `http://127.0.0.1:8787`.

## Konvence

- Všechny endpointy mimo `/health`, `POST /v1/auth/login` a `POST /v1/auth/logout` vyžadují hlavičku:

  ```
  Authorization: Bearer <session-token>
  ```

- Chybové odpovědi mají tvar:

  ```json
  { "error": "Unauthorized", "code": "unauthorized", "message": "Nejdřív se přihlaste do Claude Hubu." }
  ```

  `code` je strojově čitelný identifikátor (`unauthorized`, `bad_request`, `not_found`, `database_unavailable`, …). `error` je lidsky čitelný titulek, `message` lokalizovaný popis.

- CORS: povoleno pro `http://localhost:*` a `http://127.0.0.1:*`. Pro produkční hostování přidejte vlastní pravidla v `apps/api/src/server.ts`.

- Rate-limit: `POST /v1/auth/login` má limit 10 req/min na IP (`@fastify/rate-limit`). Ostatní endpointy zatím limit nemají.

## Endpointy

### `GET /health`

Healthcheck pro Docker / monitoring. Bez autentizace.

```json
{ "ok": true, "service": "claude-hub-api", "version": "0.1.0" }
```

### `POST /v1/auth/login`

Vytvoří nebo aktualizuje uživatele a vydá nový session token.

**Request**

```json
{ "email": "user@example.com" }
```

**Response 200**

```json
{
  "user": {
    "id": "user_3a7c...",
    "email": "user@example.com",
    "name": "user",
    "defaultTeamId": "demo-team"
  },
  "sessionToken": "<base64url 32B>",
  "expiresAt": "2026-06-11T17:30:00.000Z"
}
```

- `user.id` je deterministický (`user_<sha256(email).slice(0,24)>`).
- `name` je odvozen z části před `@`.
- Token je platný 30 dní. Plain token nikdy neopustí DB jinde než v této odpovědi.

### `GET /v1/auth/session`

Vrátí aktuálního uživatele podle session tokenu.

**Response 200**

```json
{
  "user": {
    "id": "user_3a7c...",
    "email": "user@example.com",
    "name": "user",
    "defaultTeamId": "demo-team"
  }
}
```

**Response 401** — neplatný nebo prošlý token.

### `POST /v1/auth/logout`

Smaže session z `hub_sessions`. Stačí poslat header s tokenem; tělo není nutné.

```json
{ "ok": true }
```

### `POST /v1/devices/pairing`

Eviduje hashed metadata o spárovaném zařízení. Volá web automaticky po prvním úspěšném `state` volání na daemon.

**Request**

```json
{
  "tokenHash": "<sha256(daemon-pairing-token)>",
  "label": "Notebook Kuba",
  "claudeHome": "/home/kuba/.claude"
}
```

- `tokenHash` musí mít minimálně 32 znaků.
- Plain token daemonu API nikdy nedostane.

**Response 200**

```json
{ "ok": true }
```

### `GET /v1/teams/:teamId/catalog`

Vrátí všechny assety katalogu pro daný tým, seřazené podle `updated_at DESC, slug ASC`.

**Response 200**

```json
{
  "teamId": "demo-team",
  "assets": [
    {
      "id": "skill:review-skill",
      "type": "skill",
      "slug": "review-skill",
      "name": "Review Skill",
      "summary": "...",
      "description": "...",
      "owner": { "id": "user_...", "name": "user@example.com" },
      "version": "1.0.0",
      "risk": "low",
      "tags": ["skill"],
      "usedBy": 0,
      "updatedAt": "2026-05-12T17:30:00.000Z",
      "compatibility": {
        "daemon": "0.1.0",
        "platforms": ["darwin", "linux", "windows"]
      },
      "permissions": [
        { "label": "Nízké riziko", "description": "...", "level": "low" }
      ],
      "requiredEnv": [],
      "files": [{ "path": "SKILL.md", "content": "# ..." }]
    }
  ]
}
```

### `POST /v1/teams/:teamId/catalog`

Publikování nového nebo aktualizovaného assetu do týmového katalogu (upsert na `team_id + type + slug`). Tělo musí splňovat schéma definované v `apps/api/src/routes.ts` (`assetBodySchema`). API automaticky přepíše `owner` na (id, email) přihlášeného uživatele a aktualizuje `updatedAt` na aktuální čas.

**Response 201**

```json
{ "asset": { "id": "skill:review-skill", ... } }
```

### `GET /v1/teams/:teamId/catalog/:type/:slug/versions`

Vrátí celou historii publikovaných verzí pro daný asset (z `catalog_asset_versions`).

```json
{
  "versions": [
    {
      "version": "1.1.0",
      "publishedAt": "2026-05-12T17:30:00.000Z",
      "publishedBy": "user_3a7c...",
      "asset": { /* CatalogAsset snapshot */ }
    }
  ]
}
```

### `GET /v1/teams/:teamId/events`

Vrátí audit log týmu (`catalog_events`), seřazený od nejnovější události. Query parametr `limit` (1–500, default 100).

```json
{
  "teamId": "demo-team",
  "events": [
    {
      "occurredAt": "2026-05-12T17:30:00.000Z",
      "teamId": "demo-team",
      "userId": "user_3a7c...",
      "event": "publish",
      "assetId": "skill:review-skill",
      "assetVersion": "1.0.0",
      "metadata": { "contentHash": "..." }
    }
  ]
}
```

### `POST /v1/teams/:teamId/events`

Klientské zaznamenání události. Web ho volá automaticky po každém `install` / `enable` / `disable` / `uninstall`.

Body:

```json
{
  "event": "install",
  "assetId": "skill:review-skill",
  "assetVersion": "1.0.0",
  "metadata": { "source": "web" }
}
```

### `GET /v1/devices`

Vrátí seznam zařízení spárovaných pro aktuálního uživatele.

```json
{
  "devices": [
    {
      "tokenHash": "ab12...",
      "label": "Notebook Kuba",
      "claudeHome": "/home/kuba/.claude",
      "lastSeenAt": "2026-05-12T17:25:00.000Z"
    }
  ]
}
```

### `DELETE /v1/devices/:tokenHash`

Odstraní pairing pro dané zařízení (uživatel může zařízení revoknout). Daemon na zařízení dál žije s vlastním tokenem, ale Hub mu už nepošle telemetry o uživateli.

```json
{ "ok": true }
```

### Team (single-tenant)

Instance má vždy jeden tým definovaný env proměnnou `CLAUDE_HUB_TEAM_ID`. Endpointy pro vytváření/seznam týmů neexistují — pokud chcete jiný katalog, nasaďte další instanci.

#### `GET /v1/team`

Detail týmu + membership volajícího.

```json
{
  "team": { "id": "main", "name": "Tým", "slug": "main", "isPersonal": false, "createdAt": "...", "createdBy": "system" },
  "membership": { "teamId": "main", "userId": "...", "email": "...", "role": "owner", "joinedAt": "..." }
}
```

#### `GET /v1/teams/:teamId/members`

Seznam členů (email, role, joinedAt). Členem se uživatel stává automaticky při prvním přihlášení.

#### `PATCH /v1/teams/:teamId/members/:userId`

Změna role (`owner` může povýšit/snížit kteréhokoli člena).

#### `DELETE /v1/teams/:teamId/members/:userId`

Odebrání člena (admin nebo owner). Odebraný uživatel ztratí přístup; při dalším loginu se automaticky nepřidá zpět.

### Collections

```
GET    /v1/teams/:teamId/collections
PUT    /v1/teams/:teamId/collections       { slug, name, description, assetIds }
DELETE /v1/teams/:teamId/collections/:slug
```

Slug je unikátní v rámci týmu. Upsert vytváří nebo aktualizuje řádek.

### Rollback

#### `POST /v1/teams/:teamId/catalog/:type/:slug/rollback`

```json
{ "version": "0.1.0" }
```

Vrátí asset v `catalog_assets` na obsah z `catalog_asset_versions` (admin+).

### Signing keys

```
GET    /v1/signing-keys                  — seznam neaktivních klíčů uživatele
POST   /v1/signing-keys                  — registrace { label, publicKey (base64 32B Ed25519) }
DELETE /v1/signing-keys/:keyId           — soft-revoke (revokedAt timestamp)
```

Publikování s podpisem: do `POST /v1/teams/:teamId/catalog` přidejte `signature: { signature, publicKey }`. API ověří přes Node `crypto.verify(null, sha256(canonicalFiles), publicKey, signature)`.

## Validační schéma

Vstup je validován Fastify schéma engine. Klíčové enumy:

- `type ∈ { skill, command, mcp, hook, plugin, config }`
- `risk ∈ { low, medium, high, restricted }`
- `compatibility.platforms[] ∈ { darwin, linux, windows }`

Plné schéma viz [`packages/schema/src/catalog.schema.json`](../packages/schema/src/catalog.schema.json) a TypeScript typy v [`packages/schema/src/index.ts`](../packages/schema/src/index.ts).

## Lokální fallback

Pokud uživatel není přihlášený nebo API není dostupné, web vrací prázdné pole z `apps/web/lib/catalog.ts`. To umožňuje, aby login obrazovka fungovala i bez běžícího Postgresu.

## Pozn. k testům

Integrační test `apps/api/src/repository.test.ts` se spouští pouze pokud je definováno `CLAUDE_HUB_TEST_DATABASE_URL` (nebo `CLAUDE_HUB_DATABASE_URL`). Test ověřuje:

- publikaci a opakované načtení assetu,
- správný upsert (zachová `team_id+type+slug`, ale přepíše JSON a `updated_at`),
- nezávislost na in-memory cachi (repository se po restartu načte z DB).
