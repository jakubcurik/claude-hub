# Plan 3 — Artifact Catalog (Skill MVP)

**Date:** 2026-05-09
**Status:** Ready
**Owner:** Kuba Curik (curik@animato.cz)
**Spec:** `docs/superpowers/specs/2026-05-09-claude-hub-design.md`
**Contracts:** `docs/superpowers/plans/_implementation-contracts.md`
**Depends on:** Plan 1 (repo, server core, auth, RBAC, audit, CI), Plan 2 (daemon skeleton, WSS connect, pairing, OS keychain, local API skeleton)
**Unblocks:** Plan 4 (přidá pluginy, commandy, agenty, toggle), Plan 5 (CLI publish/install).

## Cíl

Postavit kompletní end-to-end flow **publish → catalog → install** pro jeden typ artefaktu — `skill`. Skill scanner v daemonu detekuje obsah `~/.claude/skills/`, hub server spravuje katalog (Postgres + MinIO), dashboard ukáže Local + Catalog stránky, a `Install` z katalogu doručí skill na cílový stroj zpět do `~/.claude/skills/`.

Klíčový design constraint: **infra musí být typově generická.** `ArtifactType` enum, manifest parser, scanner, install/publish job a WSS protokol jsou už od MVP polymorfní — Plan 4 jen doplní implementace pro `plugin`, `command`, `agent` bez zásahu do core flow.

## Rozsah

### V tomto plánu
- Postgres schema pro artefakty (migrace `0003_artifacts.sql`).
- MinIO klient + bucket bootstrap.
- REST endpointy `/api/artifacts/*` (list, detail, version detail, upload, download, yank, archive).
- WSS rozšíření: `job.package`, `job.install`, `inventory.snapshot`/`delta`, `subscribe.local`, `local.snapshot`/`delta`, `catalog.update`.
- Daemon: skill manifest parser, scanner, fsnotify watcher, package job, install job, lokální REST endpointy `/v1/publish`, `/v1/install`, `/v1/uninstall`, `/v1/toggle`.
- Dashboard: `/local` a `/catalog` stránky včetně publish/install flow přes WSS.
- Integration testy (Testcontainers), Go unit testy, Playwright E2E.

### Mimo rozsah (Plan 4)
- Plugin/command/agent manifest parsery a scannery.
- Skutečný `toggle` (vyžaduje plugin `settings.json` editaci).
- Multi-version semver UI (zobrazí se jen latest non-deprecated v MVP).
- Federace s externími marketplaces.

## Architektura — toky

### Publish flow (z dashboardu)
```
Browser (Local page) ──REST──▶ Hub: POST /api/local/:daemonId/publish-request
                                       { slug, version, description }
Hub ──WSS──▶ Daemon: job.package { slug, type, source_path, requestId }
Daemon: tar -czf, sha256
Daemon ──REST──▶ Hub: POST /api/artifacts/upload (multipart, requestId)
Hub: validate → MinIO put → INSERT artifact_version
Hub ──WSS──▶ Browser: catalog.update + local.delta (publishedAs ref)
```

### Install flow
```
Browser (Catalog detail) ──REST──▶ Hub: POST /api/install-request
                                          { artifactId, version, daemonId }
Hub: lookup version, generate presigned MinIO download URL
Hub ──WSS──▶ Daemon: job.install { artifact_version_id, sha256, download_url, target_path, requestId }
Daemon ──REST──▶ MinIO: GET .tar.gz
Daemon: verify sha256, backup existing, extract to ~/.claude/skills/<slug>/
Daemon ──WSS──▶ Hub: job.result + inventory.delta
Hub: INSERT install_event, broadcast local.delta
```

### Generic typing
- Server: `ArtifactType` enum (drizzle `pgEnum`), polymorfní endpointy přijmou všechny 4 typy ale v MVP vrátí 400 pro typ ≠ `skill` na publish.
- Daemon: interface `ManifestParser` a `Scanner` v `internal/manifest/` resp. `internal/scanner/`. V Planu 3 implementujeme jen `SkillParser` a `SkillScanner`; registry pattern je už hotový pro Plan 4.

## Pravidla práce

- **TDD je povinné**: každý task začíná failing testem (`go test`/`vitest`), pak implementace, pak commit. Nikdy "napíšu kód a testy potom".
- **Bite-sized tasky**: 2–5 min každý, jeden commit per task. Pokud task nabobtná, rozsekni ho.
- **Conventional Commits**: `feat(server): …`, `feat(agent): …`, `feat(dashboard): …`, `test(...): …`, `chore(db): add 0003 migration`.
- **SPDX header** v každém novém zdrojovém souboru (`// SPDX-License-Identifier: Apache-2.0`).
- **Žádné placeholdery**: pokud task ukazuje kód, je to kompletní hotový kód, ne kostra.
- **Path safety**: před každým `Write`/extract do `~/.claude/skills/` ověř absenci `..` v paths a hardcoded prefix `~/.claude/skills/`. Test path-traversal payloads.
- **Verification before completion**: před označením tasku za hotový spusť testy a ověř výstup.

---

## Tasks

### Sekce A — Database & MinIO (server foundation)

Cíl: připravit perzistenci pro artefakty a versioning. Bez MinIO se nedá uploadnout, bez schématu se nedá list.

#### Task A1: Drizzle schema for `artifacts`, `artifact_versions`, `install_events`

**Soubor:** `apps/hub-server/src/db/schema/artifacts.ts`

**Test first** (`apps/hub-server/src/db/schema/artifacts.test.ts`): import schématu, `expect(artifacts.slug.notNull).toBe(true)`, ověř že enum `artifactTypeEnum` obsahuje 4 hodnoty.

```ts
// SPDX-License-Identifier: Apache-2.0
import { pgEnum, pgTable, text, timestamp, jsonb, boolean, uuid, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { daemons } from './daemons';

export const artifactTypeEnum = pgEnum('artifact_type', ['skill', 'plugin', 'command', 'agent']);
export const installStatusEnum = pgEnum('install_status', ['success', 'failed', 'rolled_back']);

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  type: artifactTypeEnum('type').notNull(),
  description: text('description').notNull().default(''),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => ({
  byType: index('artifacts_type_idx').on(t.type),
  byOwner: index('artifacts_owner_idx').on(t.ownerUserId),
}));

export const artifactVersions = pgTable('artifact_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  artifactId: uuid('artifact_id').notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
  version: text('version').notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256').notNull(),
  manifest: jsonb('manifest').notNull(),
  publishedByUserId: uuid('published_by_user_id').notNull().references(() => users.id),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  deprecated: boolean('deprecated').notNull().default(false),
}, (t) => ({
  uqVersion: uniqueIndex('artifact_versions_artifact_version_uq').on(t.artifactId, t.version),
  byPublishedAt: index('artifact_versions_published_at_idx').on(t.publishedAt),
  manifestGin: index('artifact_versions_manifest_gin').using('gin', t.manifest),
}));

export const installEvents = pgTable('install_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  daemonId: uuid('daemon_id').notNull().references(() => daemons.id),
  artifactVersionId: uuid('artifact_version_id').notNull().references(() => artifactVersions.id),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  status: installStatusEnum('status').notNull(),
}, (t) => ({
  byDaemon: index('install_events_daemon_idx').on(t.daemonId),
  byVersion: index('install_events_version_idx').on(t.artifactVersionId),
}));
```

**Verify:** `pnpm --filter hub-server test db/schema/artifacts`. Commit: `feat(server): add drizzle schema for artifacts catalog`.

---

#### Task A2: Migration `0003_artifacts.sql`

**Soubor:** `ops/migrations/0003_artifacts.sql`

Generated by `pnpm --filter hub-server drizzle-kit generate --name artifacts`. Manually verify the generated SQL matches schema, then commit raw SQL.

**Test first** (`apps/hub-server/test/integration/migrations.test.ts`): Testcontainer Postgres, run all migrations, `SELECT to_regclass('artifacts')` returns non-null, same for `artifact_versions`, `install_events`. Verify GIN index on `manifest` exists via `pg_indexes`.

Commit: `chore(db): add 0003 artifacts migration`.

---

#### Task A3: MinIO client wrapper

**Soubor:** `apps/hub-server/src/storage/minio.ts`

**Test first** (`apps/hub-server/src/storage/minio.test.ts`, integration with Testcontainers MinIO): `bootstrapBucket()` creates bucket if absent, `putArtifactBlob(key, stream, sha256)` uploads, `getArtifactBlobStream(key)` reads, `presignDownload(key, ttlSec)` returns URL that downloads same bytes.

```ts
// SPDX-License-Identifier: Apache-2.0
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { env } from '../config/env';

export const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
});

export async function bootstrapBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.MINIO_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.MINIO_BUCKET }));
  }
}

export function storageKey(artifactId: string, version: string): string {
  return `artifacts/${artifactId}/${version}.tar.gz`;
}

export function manifestKey(artifactId: string, version: string): string {
  return `artifacts/${artifactId}/${version}.manifest.json`;
}

export async function putArtifactBlob(key: string, body: Buffer | Readable, contentType = 'application/gzip'): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: env.MINIO_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

export async function getArtifactBlobStream(key: string): Promise<Readable> {
  const out = await s3.send(new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key }));
  return out.Body as Readable;
}

export async function presignDownload(key: string, ttlSec = 300): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key }), { expiresIn: ttlSec });
}
```

**Hook bootstrap into server startup** (`apps/hub-server/src/main.ts` after DB ready): `await bootstrapBucket()`.

Commit: `feat(server): add MinIO client wrapper and bucket bootstrap`.

---

### Sekce B — Manifest, validators, audit helpers

Cíl: typovaný manifest + validátory slug/semver/sha256 použitelné v REST handlerech.

#### Task B1: Slug, semver, sha256 validators (Zod)

**Soubor:** `apps/hub-server/src/lib/validators.ts`

**Test first**: `slugSchema.parse('my-skill')` ok; `'My_Skill'` throws; `semverSchema.parse('1.0.0')` ok; `'1.0'`, `'1.0.0-rc.1'` throw; `sha256Schema.parse('a'.repeat(64))` ok; `'abc'` throws.

```ts
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'invalid slug');
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be MAJOR.MINOR.PATCH');
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be 64 hex chars');
export const artifactTypeSchema = z.enum(['skill', 'plugin', 'command', 'agent']);
```

Commit: `feat(server): add catalog input validators`.

---

#### Task B2: ArtifactManifest Zod schema

**Soubor:** `apps/hub-server/src/lib/manifest-schema.ts`

**Test first**: parse a valid skill manifest `{ schemaVersion: 1, name: 'foo', type: 'skill', description: 'x', typeMeta: {} }` ok; missing `name` throws; `type: 'mcp'` throws.

```ts
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { artifactTypeSchema, slugSchema } from './validators';

export const artifactManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: slugSchema,
  type: artifactTypeSchema,
  description: z.string().min(1),
  typeMeta: z.record(z.unknown()).default({}),
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
```

Commit: `feat(server): add ArtifactManifest schema`.

---

### Sekce C — REST API endpoints

Cíl: server umí přijmout publish, vrátit list/detail, signed download, yank, archive.

#### Task C1: `POST /api/artifacts/upload` — multipart handler

**Soubor:** `apps/hub-server/src/routes/artifacts/upload.ts`

**Test first** (`apps/hub-server/test/integration/artifacts-upload.test.ts`): authed user POST multipart `slug=foo, type=skill, version=0.1.0, description=test, manifest=<json>, sha256=<hex>, file=<small.tar.gz>` → 201 with `{ artifactId, versionId }`. Re-upload same `(slug, version)` → 409. Different slug, type=`plugin` → 400 (not skill in MVP). Mismatched sha256 → 400. Slug already owned by someone else → 409 "slug taken".

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { auditLog } from '../../db/schema/audit';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../../middleware/auth';
import { slugSchema, semverSchema, sha256Schema, artifactTypeSchema } from '../../lib/validators';
import { artifactManifestSchema } from '../../lib/manifest-schema';
import { storageKey, manifestKey, putArtifactBlob } from '../../storage/minio';

export const uploadRoute = new Hono().post('/upload', requireAuth, async (c) => {
  const form = await c.req.formData();
  const slug = slugSchema.parse(form.get('slug'));
  const type = artifactTypeSchema.parse(form.get('type'));
  if (type !== 'skill') return c.json({ error: 'only skill supported in MVP' }, 400);
  const version = semverSchema.parse(form.get('version'));
  const description = String(form.get('description') ?? '');
  const sha256 = sha256Schema.parse(form.get('sha256'));
  const manifest = artifactManifestSchema.parse(JSON.parse(String(form.get('manifest'))));
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);
  const buf = Buffer.from(await file.arrayBuffer());
  const computed = createHash('sha256').update(buf).digest('hex');
  if (computed !== sha256) return c.json({ error: 'sha256 mismatch' }, 400);

  const user = c.get('user');
  const existing = await db.select().from(artifacts).where(eq(artifacts.slug, slug)).limit(1);
  if (existing[0] && existing[0].ownerUserId !== user.id) return c.json({ error: 'slug taken' }, 409);

  return await db.transaction(async (tx) => {
    let artifactId: string;
    if (existing[0]) {
      artifactId = existing[0].id;
      const dup = await tx.select().from(artifactVersions)
        .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.version, version)))
        .limit(1);
      if (dup[0]) return c.json({ error: 'version exists' }, 409);
    } else {
      const [a] = await tx.insert(artifacts).values({ slug, type, description, ownerUserId: user.id }).returning();
      artifactId = a.id;
    }
    const sk = storageKey(artifactId, version);
    await putArtifactBlob(sk, buf);
    await putArtifactBlob(manifestKey(artifactId, version), Buffer.from(JSON.stringify(manifest)), 'application/json');
    const [v] = await tx.insert(artifactVersions).values({
      artifactId, version, storageKey: sk, sha256, manifest, publishedByUserId: user.id,
    }).returning();
    await tx.insert(auditLog).values({
      actorUserId: user.id, action: 'artifact.publish',
      targetType: 'artifact_version', targetId: v.id, payload: { slug, version },
    });
    return c.json({ artifactId, versionId: v.id }, 201);
  });
});
```

Commit: `feat(server): add POST /api/artifacts/upload`.

---

#### Task C2: `GET /api/artifacts` — list with filters

**Soubor:** `apps/hub-server/src/routes/artifacts/list.ts`

**Test first**: seed 3 artifacts (2 skills, 1 plugin), `GET /api/artifacts?type=skill` returns 2; `?q=helper` matches description ILIKE; `?page=1&limit=1` returns 1 with `total:3`. Archived artifacts excluded by default.

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import { requireAuth } from '../../middleware/auth';
import { artifactTypeSchema } from '../../lib/validators';

const querySchema = z.object({
  type: artifactTypeSchema.optional(),
  q: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listRoute = new Hono().get('/', requireAuth, async (c) => {
  const { type, q, page, limit } = querySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const conds = [isNull(artifacts.archivedAt)];
  if (type) conds.push(eq(artifacts.type, type));
  if (q) conds.push(ilike(artifacts.description, `%${q}%`));
  const where = and(...conds);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(artifacts).where(where);
  const rows = await db.select({
    id: artifacts.id, slug: artifacts.slug, type: artifacts.type, description: artifacts.description,
    ownerUserId: artifacts.ownerUserId, createdAt: artifacts.createdAt, archivedAt: artifacts.archivedAt,
    latestVersion: sql<string | null>`(
      SELECT version FROM ${artifactVersions} av
      WHERE av.artifact_id = ${artifacts.id} AND av.deprecated = false
      ORDER BY string_to_array(av.version, '.')::int[] DESC LIMIT 1
    )`,
  }).from(artifacts).where(where).orderBy(desc(artifacts.createdAt))
    .limit(limit).offset((page - 1) * limit);

  return c.json({ items: rows, page, limit, total: count });
});
```

Commit: `feat(server): add GET /api/artifacts list endpoint`.

---

#### Task C3: `GET /api/artifacts/:slug` — detail with versions

**Test first**: seed artifact with 2 versions (one deprecated), GET returns artifact + array of versions sorted by publishedAt desc, deprecated flagged correctly.

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { eq, desc } from 'drizzle-orm';
import { requireAuth } from '../../middleware/auth';
import { slugSchema } from '../../lib/validators';

export const detailRoute = new Hono().get('/:slug', requireAuth, async (c) => {
  const slug = slugSchema.parse(c.req.param('slug'));
  const [a] = await db.select().from(artifacts).where(eq(artifacts.slug, slug)).limit(1);
  if (!a) return c.json({ error: 'not found' }, 404);
  const versions = await db.select().from(artifactVersions)
    .where(eq(artifactVersions.artifactId, a.id))
    .orderBy(desc(artifactVersions.publishedAt));
  return c.json({ artifact: a, versions });
});
```

Commit: `feat(server): add GET /api/artifacts/:slug detail endpoint`.

---

#### Task C4: `GET /api/artifacts/:slug/versions/:version`

**Test first**: returns version with embedded manifest. 404 on unknown.

Commit: `feat(server): add version detail endpoint`.

---

#### Task C5: `GET /api/artifacts/:slug/versions/:version/download` — presigned redirect

**Test first**: authed GET → 302 redirect to URL containing `X-Amz-Signature`; following redirect (in test, with `redirect: 'follow'` against MinIO testcontainer) downloads bytes whose sha256 matches `version.sha256`.

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../../middleware/auth';
import { presignDownload } from '../../storage/minio';
import { slugSchema, semverSchema } from '../../lib/validators';

export const downloadRoute = new Hono().get('/:slug/versions/:version/download', requireAuth, async (c) => {
  const slug = slugSchema.parse(c.req.param('slug'));
  const version = semverSchema.parse(c.req.param('version'));
  const [row] = await db.select({ key: artifactVersions.storageKey, sha: artifactVersions.sha256 })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(and(eq(artifacts.slug, slug), eq(artifactVersions.version, version)))
    .limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  const url = await presignDownload(row.key, 300);
  return c.json({ downloadUrl: url, sha256: row.sha });
});
```

Note: returns JSON with URL + sha256 (not redirect) so the client can verify. Commit: `feat(server): add presigned download endpoint`.

---

#### Task C6: `POST /api/artifacts/:slug/yank` — owner or admin

**Test first**: owner POST → all versions `deprecated=true`. Other member POST → 403. Admin POST → ok. Audit log row written.

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../../middleware/auth';
import { auditLog } from '../../db/schema/audit';
import { slugSchema } from '../../lib/validators';

export const yankRoute = new Hono().post('/:slug/yank', requireAuth, async (c) => {
  const slug = slugSchema.parse(c.req.param('slug'));
  const user = c.get('user');
  const [a] = await db.select().from(artifacts).where(eq(artifacts.slug, slug)).limit(1);
  if (!a) return c.json({ error: 'not found' }, 404);
  if (a.ownerUserId !== user.id && user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await db.update(artifactVersions).set({ deprecated: true }).where(eq(artifactVersions.artifactId, a.id));
  await db.insert(auditLog).values({
    actorUserId: user.id, action: 'artifact.yank', targetType: 'artifact', targetId: a.id, payload: { slug },
  });
  return c.json({ ok: true });
});
```

Commit: `feat(server): add yank endpoint with RBAC`.

---

#### Task C7: `DELETE /api/artifacts/:slug` — admin archive

**Test first**: member DELETE → 403. Admin DELETE → `archivedAt` set, list endpoint excludes it. Audit log row.

Commit: `feat(server): add admin archive endpoint`.

---

#### Task C8: Mount artifact routes + RBAC integration

**Soubor:** `apps/hub-server/src/routes/index.ts` add `app.route('/api/artifacts', artifactsRouter)`.

**Test first** (RBAC sweep): unauthenticated → 401 on every endpoint; member can list/detail/upload/yank own; admin can archive any; member cannot yank others.

Commit: `feat(server): wire artifact routes and verify RBAC`.

---

### Sekce D — WSS protocol extension

Cíl: server a daemon mluví o jobs a inventory. Protokol je typově generický.

#### Task D1: Extend `packages/wss-protocol` with new message types

**Soubor:** `packages/wss-protocol/src/messages.ts`

**Test first**: `parseMessage({ type: 'job.install', payload: {...}, id: 'r1' })` validates ok; missing required fields throw.

```ts
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const inventoryItemSchema = z.object({
  type: z.enum(['skill', 'plugin', 'command', 'agent']),
  slug: z.string(),
  version: z.string().nullable(),
  path: z.string(),
  enabled: z.boolean().nullable(),
  publishedAs: z.object({ artifactId: z.string(), version: z.string() }).optional(),
});

export const wssMessageSchema = z.discriminatedUnion('type', [
  // Daemon → Hub
  z.object({ type: z.literal('inventory.snapshot'), id: z.string(), payload: z.object({ items: z.array(inventoryItemSchema) }) }),
  z.object({ type: z.literal('inventory.delta'), id: z.string(), payload: z.object({
    added: z.array(inventoryItemSchema).default([]),
    removed: z.array(z.object({ type: z.string(), slug: z.string() })).default([]),
    modified: z.array(inventoryItemSchema).default([]),
  })}),
  z.object({ type: z.literal('job.result'), id: z.string(), payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    data: z.record(z.unknown()).optional(),
  })}),
  z.object({ type: z.literal('pong'), id: z.string(), payload: z.object({}) }),

  // Hub → Daemon
  z.object({ type: z.literal('job.install'), id: z.string(), payload: z.object({
    requestId: z.string(),
    artifactVersionId: z.string(),
    type: z.enum(['skill', 'plugin', 'command', 'agent']),
    slug: z.string(),
    version: z.string(),
    sha256: z.string(),
    downloadUrl: z.string(),
    targetPath: z.string(),
  })}),
  z.object({ type: z.literal('job.package'), id: z.string(), payload: z.object({
    requestId: z.string(),
    slug: z.string(),
    type: z.enum(['skill', 'plugin', 'command', 'agent']),
    version: z.string(),
    description: z.string(),
    sourcePath: z.string(),
  })}),
  z.object({ type: z.literal('ping'), id: z.string(), payload: z.object({}) }),

  // Dashboard ↔ Hub
  z.object({ type: z.literal('subscribe.local'), id: z.string(), payload: z.object({ daemonId: z.string() }) }),
  z.object({ type: z.literal('local.snapshot'), id: z.string(), payload: z.object({ daemonId: z.string(), items: z.array(inventoryItemSchema) }) }),
  z.object({ type: z.literal('local.delta'), id: z.string(), payload: z.object({
    daemonId: z.string(),
    added: z.array(inventoryItemSchema).default([]),
    removed: z.array(z.object({ type: z.string(), slug: z.string() })).default([]),
    modified: z.array(inventoryItemSchema).default([]),
  })}),
  z.object({ type: z.literal('catalog.update'), id: z.string(), payload: z.object({
    artifactId: z.string(),
    slug: z.string(),
    type: z.enum(['skill', 'plugin', 'command', 'agent']),
    version: z.string(),
  })}),
]);

export type WssMessage = z.infer<typeof wssMessageSchema>;
export function parseMessage(raw: unknown): WssMessage { return wssMessageSchema.parse(raw); }
```

**Generate JSON Schema** (`packages/wss-protocol/scripts/emit-jsonschema.ts`) for Go side. Commit: `feat(protocol): extend WSS messages for jobs and inventory`.

---

#### Task D2: Hub WSS gateway — connection registry split daemon vs browser

**Soubor:** `apps/hub-server/src/ws/gateway.ts`

**Test first**: connect with `Authorization: Bearer <device_token>` → registered as daemon, `getDaemonSocket(daemonId)` returns it. Connect with session token → registered as browser, `subscribeBrowserToDaemon(sessionId, daemonId)` puts it in broadcast group. Disconnect cleans up.

Commit: `feat(server): split WSS registry into daemon and browser pools`.

---

#### Task D3: Inventory broadcast — daemon snapshot/delta to subscribed browsers

**Test first**: open daemon WSS, send `inventory.snapshot`. Open browser WSS, send `subscribe.local`. Daemon sends another `inventory.delta` → browser receives `local.delta` with same payload. Two browsers subscribed → both get it.

```ts
// SPDX-License-Identifier: Apache-2.0
// inside ws/gateway.ts
function handleDaemonMessage(daemonId: string, msg: WssMessage) {
  if (msg.type === 'inventory.snapshot') {
    daemonInventory.set(daemonId, msg.payload.items);
    broadcastToSubscribers(daemonId, { type: 'local.snapshot', id: nanoid(), payload: { daemonId, items: msg.payload.items } });
  } else if (msg.type === 'inventory.delta') {
    applyDelta(daemonId, msg.payload);
    broadcastToSubscribers(daemonId, { type: 'local.delta', id: nanoid(), payload: { daemonId, ...msg.payload } });
  } else if (msg.type === 'job.result') {
    pendingJobs.get(msg.payload.requestId)?.resolve(msg.payload);
  }
}
```

Commit: `feat(server): broadcast inventory snapshots and deltas to dashboard subscribers`.

---

#### Task D4: `catalog.update` broadcast on publish

**Soubor:** wire into `upload.ts` after successful insert.

**Test first**: open browser WSS, POST upload from another session → browser receives `catalog.update` within 500ms.

```ts
// after successful tx in upload.ts
gateway.broadcastAll({ type: 'catalog.update', id: nanoid(), payload: { artifactId, slug, type, version } });
```

Commit: `feat(server): broadcast catalog.update on publish`.

---

#### Task D5: Job request/response correlation

**Soubor:** `apps/hub-server/src/ws/jobs.ts`

**Test first**: `await sendJob(daemonId, { type: 'job.install', payload: {...} })` resolves when daemon emits matching `job.result`. Timeout 30s rejects.

```ts
// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';
const pending = new Map<string, { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

export function sendJob(daemonId: string, type: 'job.install' | 'job.package', payload: any, timeoutMs = 30_000): Promise<any> {
  const sock = getDaemonSocket(daemonId);
  if (!sock) return Promise.reject(new Error('daemon offline'));
  const requestId = nanoid();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('job timeout')); }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    sock.send(JSON.stringify({ type, id: nanoid(), payload: { requestId, ...payload } }));
  });
}

export function resolveJob(requestId: string, result: any) {
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  p.resolve(result);
}
```

Commit: `feat(server): add WSS job request/response correlator`.

---

### Sekce E — Daemon: skill manifest, scanner, watcher

Cíl: daemon zná svůj inventář skills a hlásí změny.

#### Task E1: Skill manifest parser

**Soubor:** `apps/agent/internal/manifest/skill.go`

**Test first** (`apps/agent/internal/manifest/skill_test.go`): parse `SKILL.md` with frontmatter `---\nname: foo\ndescription: bar\n---\nbody`. Returns `ArtifactManifest{Name:"foo", Description:"bar", Type:"skill", SchemaVersion:1, TypeMeta:{}}`. Missing `name` → error. Empty file → error.

```go
// SPDX-License-Identifier: Apache-2.0
package manifest

import (
    "errors"
    "os"
    "path/filepath"
    "strings"
    "gopkg.in/yaml.v3"
)

type ArtifactManifest struct {
    SchemaVersion int                    `json:"schemaVersion"`
    Name          string                 `json:"name"`
    Type          string                 `json:"type"`
    Description   string                 `json:"description"`
    TypeMeta      map[string]interface{} `json:"typeMeta"`
}

type Parser interface {
    Parse(rootDir string) (*ArtifactManifest, error)
}

type SkillParser struct{}

func (SkillParser) Parse(rootDir string) (*ArtifactManifest, error) {
    candidates := []string{filepath.Join(rootDir, "SKILL.md"), filepath.Join(rootDir, filepath.Base(rootDir)+".md")}
    var data []byte
    var err error
    for _, p := range candidates {
        data, err = os.ReadFile(p)
        if err == nil { break }
    }
    if err != nil { return nil, errors.New("no SKILL.md found") }
    text := string(data)
    if !strings.HasPrefix(text, "---\n") { return nil, errors.New("missing frontmatter") }
    end := strings.Index(text[4:], "\n---\n")
    if end < 0 { return nil, errors.New("unterminated frontmatter") }
    fm := text[4 : 4+end]
    var raw struct{ Name, Description string }
    if err := yaml.Unmarshal([]byte(fm), &raw); err != nil { return nil, err }
    if raw.Name == "" { return nil, errors.New("name required") }
    return &ArtifactManifest{
        SchemaVersion: 1, Name: raw.Name, Type: "skill",
        Description: raw.Description, TypeMeta: map[string]interface{}{},
    }, nil
}
```

Commit: `feat(agent): add skill manifest parser`.

---

#### Task E2: Generic Scanner interface + SkillScanner

**Soubor:** `apps/agent/internal/scanner/scanner.go` and `skills.go`

**Test first**: temp dir with `skills/foo/SKILL.md`, `skills/bar/SKILL.md`, `skills/.broken/` (no manifest). `SkillScanner{Root:tmp}.Scan()` returns 2 items, slugs `foo`, `bar`, paths absolute. Broken dir is skipped (logged, not erroring).

```go
// SPDX-License-Identifier: Apache-2.0
package scanner

import "claude-hub/agent/internal/api"

type Scanner interface {
    Scan() ([]api.InventoryItem, error)
    Type() api.ArtifactType
}
```

```go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
    "log/slog"
    "os"
    "path/filepath"
    "claude-hub/agent/internal/api"
    "claude-hub/agent/internal/manifest"
)

type SkillScanner struct{ Root string }

func (s SkillScanner) Type() api.ArtifactType { return api.TypeSkill }

func (s SkillScanner) Scan() ([]api.InventoryItem, error) {
    entries, err := os.ReadDir(s.Root)
    if err != nil {
        if os.IsNotExist(err) { return []api.InventoryItem{}, nil }
        return nil, err
    }
    parser := manifest.SkillParser{}
    out := make([]api.InventoryItem, 0, len(entries))
    for _, e := range entries {
        if !e.IsDir() || e.Name() == ".claude-hub-backup" { continue }
        full := filepath.Join(s.Root, e.Name())
        if _, err := parser.Parse(full); err != nil {
            slog.Warn("skipping skill", "dir", full, "err", err)
            continue
        }
        out = append(out, api.InventoryItem{
            Type: api.TypeSkill, Slug: e.Name(), Path: full, Enabled: nil,
        })
    }
    return out, nil
}
```

Commit: `feat(agent): add scanner interface and skill scanner`.

---

#### Task E3: fsnotify watcher with debounce

**Soubor:** `apps/agent/internal/scanner/watcher.go`

**Test first**: temp dir, watcher subscribes, emit channel. Create file → debounced single rescan within 500ms. Multiple rapid changes → coalesced. Stop() returns cleanly.

```go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
    "context"
    "time"
    "github.com/fsnotify/fsnotify"
)

type Watcher struct {
    scanner Scanner
    out     chan []byte // serialized inventory or sentinel
}

func NewWatcher(s Scanner) *Watcher { return &Watcher{scanner: s, out: make(chan []byte, 4)} }

func (w *Watcher) Run(ctx context.Context, root string, onChange func()) error {
    fw, err := fsnotify.NewWatcher()
    if err != nil { return err }
    defer fw.Close()
    if err := fw.Add(root); err != nil && !isNotExist(err) { return err }
    var timer *time.Timer
    fire := func() {
        if timer != nil { timer.Stop() }
        timer = time.AfterFunc(500*time.Millisecond, onChange)
    }
    for {
        select {
        case <-ctx.Done(): return nil
        case <-fw.Events: fire()
        case <-fw.Errors:
        }
    }
}
```

Commit: `feat(agent): add debounced fsnotify watcher`.

---

#### Task E4: Wire scanner → WSS inventory.snapshot on connect

**Soubor:** `apps/agent/internal/wss/inventory.go`

**Test first**: mock WSS server, daemon connects, scanner returns 2 items → server receives `inventory.snapshot` with both items. After watcher fires, daemon emits `inventory.delta`.

```go
// SPDX-License-Identifier: Apache-2.0
func (c *Client) PushInventorySnapshot() error {
    items, err := c.scanRegistry.ScanAll()
    if err != nil { return err }
    return c.send("inventory.snapshot", map[string]any{"items": items})
}

func (c *Client) PushInventoryDelta(prev, cur []api.InventoryItem) error {
    diff := diffInventory(prev, cur)
    return c.send("inventory.delta", diff)
}
```

`diffInventory` produces `{added, removed, modified}` (modified = same key, different version/enabled).

Commit: `feat(agent): push inventory snapshots and deltas over WSS`.

---

### Sekce F — Daemon: package and install jobs

Cíl: daemon umí zabalit skill a uploadnout, a stáhnout + extrahovat.

#### Task F1: Tar.gz packager

**Soubor:** `apps/agent/internal/jobs/package.go`

**Test first**: temp dir with files, `PackageDir(src, dest)` produces gzip tar that, when extracted, equals source tree (file modes, content). sha256 returned matches gzip bytes.

```go
// SPDX-License-Identifier: Apache-2.0
package jobs

import (
    "archive/tar"
    "compress/gzip"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "os"
    "path/filepath"
)

func PackageDir(src, dest string) (string, error) {
    f, err := os.Create(dest)
    if err != nil { return "", err }
    defer f.Close()
    h := sha256.New()
    mw := io.MultiWriter(f, h)
    gz := gzip.NewWriter(mw)
    tw := tar.NewWriter(gz)
    err = filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
        if err != nil { return err }
        rel, err := filepath.Rel(src, p)
        if err != nil { return err }
        if rel == "." { return nil }
        hdr, err := tar.FileInfoHeader(info, "")
        if err != nil { return err }
        hdr.Name = filepath.ToSlash(rel)
        if err := tw.WriteHeader(hdr); err != nil { return err }
        if !info.Mode().IsRegular() { return nil }
        rf, err := os.Open(p); if err != nil { return err }
        defer rf.Close()
        _, err = io.Copy(tw, rf)
        return err
    })
    if err != nil { return "", err }
    if err := tw.Close(); err != nil { return "", err }
    if err := gz.Close(); err != nil { return "", err }
    return hex.EncodeToString(h.Sum(nil)), nil
}
```

Commit: `feat(agent): add tar.gz packager with sha256`.

---

#### Task F2: Publish job — package + REST upload

**Soubor:** `apps/agent/internal/jobs/publish.go`

**Test first**: spin up `httptest` hub server with `/api/artifacts/upload` accepting multipart and asserting fields. Daemon `PublishSkill(slug, version, description, srcPath)` → server receives expected form, daemon returns `{artifactId, versionId}`.

```go
// SPDX-License-Identifier: Apache-2.0
package jobs

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "mime/multipart"
    "net/http"
    "os"
    "path/filepath"
)

type PublishRequest struct {
    Slug, Type, Version, Description, SourcePath string
}
type PublishResult struct{ ArtifactID, VersionID string }

func (j *Jobs) Publish(req PublishRequest) (*PublishResult, error) {
    parser := j.parsers[req.Type]
    m, err := parser.Parse(req.SourcePath)
    if err != nil { return nil, err }
    m.Description = req.Description // override from request
    tmp := filepath.Join(os.TempDir(), fmt.Sprintf("hub-pub-%s-%s.tar.gz", req.Slug, req.Version))
    defer os.Remove(tmp)
    sha, err := PackageDir(req.SourcePath, tmp)
    if err != nil { return nil, err }

    body := &bytes.Buffer{}
    w := multipart.NewWriter(body)
    _ = w.WriteField("slug", req.Slug)
    _ = w.WriteField("type", req.Type)
    _ = w.WriteField("version", req.Version)
    _ = w.WriteField("description", req.Description)
    _ = w.WriteField("sha256", sha)
    mj, _ := json.Marshal(m)
    _ = w.WriteField("manifest", string(mj))
    fw, _ := w.CreateFormFile("file", filepath.Base(tmp))
    f, _ := os.Open(tmp)
    defer f.Close()
    if _, err := io.Copy(fw, f); err != nil { return nil, err }
    w.Close()

    httpReq, _ := http.NewRequest("POST", j.hubURL+"/api/artifacts/upload", body)
    httpReq.Header.Set("Content-Type", w.FormDataContentType())
    httpReq.Header.Set("Authorization", "Bearer "+j.deviceToken)
    resp, err := j.httpClient.Do(httpReq)
    if err != nil { return nil, err }
    defer resp.Body.Close()
    if resp.StatusCode >= 400 {
        b, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("upload failed: %d %s", resp.StatusCode, string(b))
    }
    var out PublishResult
    if err := json.NewDecoder(resp.Body).Decode(&out); err != nil { return nil, err }
    return &out, nil
}
```

Commit: `feat(agent): add publish job (package + REST upload)`.

---

#### Task F3: Install job — download, verify, extract with backup

**Soubor:** `apps/agent/internal/jobs/install.go`

**Test first**:
- (a) httptest server serves a tar.gz; daemon `Install({downloadUrl, sha256, targetPath:".../skills/foo"})` extracts to target. Files match.
- (b) Existing target → backup dir created at `~/.claude/skills/.claude-hub-backup/foo-<ts>/`, original still recoverable.
- (c) sha256 mismatch → returns error, target unchanged.
- (d) Path traversal: tar contains `../../../etc/passwd` → rejected, target unchanged.

```go
// SPDX-License-Identifier: Apache-2.0
package jobs

import (
    "archive/tar"
    "compress/gzip"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "strings"
    "time"
)

type InstallRequest struct {
    DownloadURL string
    Sha256      string
    TargetPath  string // absolute, must be within ~/.claude/skills/
    SkillsRoot  string // e.g. ~/.claude/skills
}

func (j *Jobs) Install(req InstallRequest) error {
    abs, err := filepath.Abs(req.TargetPath)
    if err != nil { return err }
    rootAbs, err := filepath.Abs(req.SkillsRoot)
    if err != nil { return err }
    if !strings.HasPrefix(abs, rootAbs+string(os.PathSeparator)) {
        return fmt.Errorf("target outside skills root")
    }

    resp, err := http.Get(req.DownloadURL)
    if err != nil { return err }
    defer resp.Body.Close()
    if resp.StatusCode != 200 { return fmt.Errorf("download status %d", resp.StatusCode) }

    tmp, err := os.CreateTemp("", "hub-install-*.tar.gz")
    if err != nil { return err }
    defer os.Remove(tmp.Name())
    h := sha256.New()
    if _, err := io.Copy(io.MultiWriter(tmp, h), resp.Body); err != nil { return err }
    if hex.EncodeToString(h.Sum(nil)) != req.Sha256 { return fmt.Errorf("sha256 mismatch") }
    if _, err := tmp.Seek(0, 0); err != nil { return err }

    // backup
    if _, err := os.Stat(abs); err == nil {
        backupRoot := filepath.Join(rootAbs, ".claude-hub-backup")
        _ = os.MkdirAll(backupRoot, 0o755)
        backupDir := filepath.Join(backupRoot, fmt.Sprintf("%s-%d", filepath.Base(abs), time.Now().Unix()))
        if err := os.Rename(abs, backupDir); err != nil { return err }
    }
    if err := os.MkdirAll(abs, 0o755); err != nil { return err }

    gz, err := gzip.NewReader(tmp)
    if err != nil { return err }
    defer gz.Close()
    tr := tar.NewReader(gz)
    for {
        hdr, err := tr.Next()
        if err == io.EOF { break }
        if err != nil { return err }
        if strings.Contains(hdr.Name, "..") { return fmt.Errorf("unsafe path in archive: %s", hdr.Name) }
        out := filepath.Join(abs, filepath.FromSlash(hdr.Name))
        outAbs, _ := filepath.Abs(out)
        if !strings.HasPrefix(outAbs, abs+string(os.PathSeparator)) && outAbs != abs {
            return fmt.Errorf("escape attempt: %s", hdr.Name)
        }
        switch hdr.Typeflag {
        case tar.TypeDir:
            _ = os.MkdirAll(out, os.FileMode(hdr.Mode))
        case tar.TypeReg:
            _ = os.MkdirAll(filepath.Dir(out), 0o755)
            f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode))
            if err != nil { return err }
            if _, err := io.Copy(f, tr); err != nil { f.Close(); return err }
            f.Close()
        }
    }
    return nil
}
```

Commit: `feat(agent): add install job with backup and path-traversal guard`.

---

#### Task F4: WSS router handles `job.install` and `job.package`

**Soubor:** `apps/agent/internal/wss/router.go`

**Test first**: feed `job.install` message to router → install job invoked, `job.result` emitted with `requestId` and `ok:true`. Same for `job.package` → publish job runs, result includes `artifactId/versionId`. Failure case → `ok:false, error:"..."`.

```go
// SPDX-License-Identifier: Apache-2.0
func (c *Client) handleMessage(raw []byte) {
    var msg struct{ Type, ID string; Payload json.RawMessage }
    if err := json.Unmarshal(raw, &msg); err != nil { return }
    switch msg.Type {
    case "job.install":
        var p InstallPayload
        _ = json.Unmarshal(msg.Payload, &p)
        go c.runJob(p.RequestID, func() (any, error) {
            return nil, c.jobs.Install(p.ToRequest(c.skillsRoot))
        })
    case "job.package":
        var p PackagePayload
        _ = json.Unmarshal(msg.Payload, &p)
        go c.runJob(p.RequestID, func() (any, error) {
            return c.jobs.Publish(p.ToRequest())
        })
    case "ping":
        c.send("pong", map[string]any{})
    }
}
```

`runJob` serializes through a channel queue (max parallel 1) and emits `job.result`.

Commit: `feat(agent): handle install and package jobs in WSS router`.

---

### Sekce G — Daemon local HTTP API

Cíl: CLI (Plan 5) i Plan 3 dashboard přes hub může delegovat akce na daemon.

#### Task G1: `POST /v1/publish` local endpoint

**Soubor:** `apps/agent/internal/api/local/publish.go`

**Test first** (`apps/agent/internal/api/local/publish_test.go`): POST with valid body → calls `jobs.Publish`, returns `{artifactId, versionId}`. Bearer token mismatch → 401. Invalid type → 400.

Commit: `feat(agent): add local /v1/publish endpoint`.

---

#### Task G2: `POST /v1/install` local endpoint

**Soubor:** `apps/agent/internal/api/local/install.go`

**Test first**: POST `{artifact_id, version}` → daemon calls hub `GET /artifacts/.../download`, runs install. Returns `{ok:true, path:".../skills/foo"}`. Hub 404 → daemon 502.

Commit: `feat(agent): add local /v1/install endpoint`.

---

#### Task G3: `POST /v1/uninstall` local endpoint

**Soubor:** `apps/agent/internal/api/local/uninstall.go`

**Test first**: existing skill at `.../skills/foo` → POST moves to `.claude-hub-backup/foo-<ts>/`, original gone. Skill not found → 404.

Commit: `feat(agent): add local /v1/uninstall endpoint`.

---

#### Task G4: `POST /v1/toggle` — MVP no-op for skills

**Test first**: POST `{artifact_id, enabled:false}` for a skill → 400 with body `{"error":"skills don't support toggle in MVP"}`. (Plan 4 adds plugin handler.)

```go
func toggleHandler(w http.ResponseWriter, r *http.Request) {
    var req struct { ArtifactID string `json:"artifact_id"`; Enabled bool `json:"enabled"` }
    _ = json.NewDecoder(r.Body).Decode(&req)
    // resolve type from local registry
    item, ok := registry.FindByArtifactID(req.ArtifactID)
    if !ok { http.Error(w, "not found", 404); return }
    if item.Type == "skill" {
        http.Error(w, `{"error":"skills don't support toggle in MVP"}`, 400); return
    }
    http.Error(w, "type not supported yet", 501)
}
```

Commit: `feat(agent): add /v1/toggle stub returning 400 for skills`.

---

### Sekce H — Hub server: dashboard helper endpoints

Cíl: dashboard zavolá REST a hub vyřídí job přes WSS.

#### Task H1: `POST /api/local/:daemonId/publish-request`

**Soubor:** `apps/hub-server/src/routes/local/publish-request.ts`

**Test first**: authed user owns `daemonId` → request triggers `sendJob(daemonId, 'job.package', {...})`, mock daemon responds with `{ok:true, data:{artifactId, versionId}}` → endpoint returns 200 with same data. Daemon offline → 503. Wrong owner → 403.

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db';
import { daemons } from '../../db/schema/daemons';
import { eq, and } from 'drizzle-orm';
import { sendJob } from '../../ws/jobs';
import { requireAuth } from '../../middleware/auth';
import { slugSchema, semverSchema, artifactTypeSchema } from '../../lib/validators';

const bodySchema = z.object({
  slug: slugSchema, type: artifactTypeSchema, version: semverSchema,
  description: z.string().min(1), sourcePath: z.string().min(1),
});

export const publishRequestRoute = new Hono().post('/:daemonId/publish-request', requireAuth, async (c) => {
  const user = c.get('user');
  const daemonId = c.req.param('daemonId');
  const [d] = await db.select().from(daemons).where(and(eq(daemons.id, daemonId), eq(daemons.userId, user.id))).limit(1);
  if (!d) return c.json({ error: 'forbidden' }, 403);
  const body = bodySchema.parse(await c.req.json());
  if (body.type !== 'skill') return c.json({ error: 'only skill in MVP' }, 400);
  try {
    const result = await sendJob(daemonId, 'job.package', body, 60_000);
    if (!result.ok) return c.json({ error: result.error ?? 'job failed' }, 502);
    return c.json(result.data);
  } catch (e: any) {
    if (e.message === 'daemon offline') return c.json({ error: 'daemon offline' }, 503);
    throw e;
  }
});
```

Commit: `feat(server): add publish-request endpoint that brokers to daemon`.

---

#### Task H2: `POST /api/install-request`

**Test first**: authed user, valid `daemonId` (owns), valid `artifactId` + `version` → hub looks up version, generates presigned URL, sends `job.install`, awaits `job.result`. On success → INSERT install_event, return 200. Cross-user daemon → 403.

```ts
// SPDX-License-Identifier: Apache-2.0
export const installRequestRoute = new Hono().post('/install-request', requireAuth, async (c) => {
  const user = c.get('user');
  const body = z.object({ artifactId: z.string().uuid(), version: semverSchema, daemonId: z.string().uuid() })
    .parse(await c.req.json());
  const [d] = await db.select().from(daemons)
    .where(and(eq(daemons.id, body.daemonId), eq(daemons.userId, user.id))).limit(1);
  if (!d) return c.json({ error: 'forbidden' }, 403);
  const [v] = await db.select({ id: artifactVersions.id, key: artifactVersions.storageKey,
      sha: artifactVersions.sha256, slug: artifacts.slug, type: artifacts.type })
    .from(artifactVersions).innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(and(eq(artifactVersions.artifactId, body.artifactId), eq(artifactVersions.version, body.version))).limit(1);
  if (!v) return c.json({ error: 'not found' }, 404);
  const url = await presignDownload(v.key, 300);
  const targetPath = `~/.claude/skills/${v.slug}`; // daemon resolves ~
  try {
    const result = await sendJob(body.daemonId, 'job.install', {
      artifactVersionId: v.id, type: v.type, slug: v.slug, version: body.version,
      sha256: v.sha, downloadUrl: url, targetPath,
    }, 120_000);
    await db.insert(installEvents).values({
      daemonId: body.daemonId, artifactVersionId: v.id,
      status: result.ok ? 'success' : 'failed',
    });
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json({ ok: true });
  } catch (e: any) {
    if (e.message === 'daemon offline') return c.json({ error: 'daemon offline' }, 503);
    throw e;
  }
});
```

Commit: `feat(server): add install-request endpoint that brokers to daemon`.

---

### Sekce I — Dashboard

Cíl: uživatel vidí Local + Catalog a může publish/install kliknutím.

#### Task I1: WSS client hook (`useHubSocket`)

**Soubor:** `apps/dashboard/src/lib/use-hub-socket.ts`

**Test first** (vitest with mock WebSocket): hook connects, sends `subscribe.local`, exposes `inventory` state, reconnects on close with backoff (100, 500, 2000 ms cap 10s).

```ts
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { parseMessage, type WssMessage } from '@hub/wss-protocol';

export function useHubSocket(url: string, onMessage: (m: WssMessage) => void) {
  const [status, setStatus] = useState<'connecting'|'open'|'closed'>('connecting');
  const sockRef = useRef<WebSocket | null>(null);
  const sendRef = useRef<(m: WssMessage) => void>(() => {});
  useEffect(() => {
    let attempt = 0; let cancelled = false;
    const connect = () => {
      const s = new WebSocket(url);
      sockRef.current = s;
      s.onopen = () => { setStatus('open'); attempt = 0; };
      s.onmessage = (e) => { try { onMessage(parseMessage(JSON.parse(e.data))); } catch {} };
      s.onclose = () => {
        setStatus('closed');
        if (!cancelled) {
          const delay = Math.min(10_000, 100 * 2 ** attempt++);
          setTimeout(connect, delay);
        }
      };
      sendRef.current = (m) => s.readyState === 1 && s.send(JSON.stringify(m));
    };
    connect();
    return () => { cancelled = true; sockRef.current?.close(); };
  }, [url]);
  return { status, send: (m: WssMessage) => sendRef.current(m) };
}
```

Commit: `feat(dashboard): add useHubSocket hook with reconnect`.

---

#### Task I2: `/local` page — inventory table + Publish modal

**Soubor:** `apps/dashboard/src/app/local/page.tsx`

**Test first** (Playwright in I8): page lists items from `local.snapshot`, shows `Publish` button when `publishedAs` undefined.

UI: TanStack Table, columns Type/Slug/Version/Path/Action. On mount: fetch `GET /api/daemons` for own daemons, pick first online, send `subscribe.local`. Maintain inventory state from `local.snapshot`/`local.delta`.

Publish button opens shadcn Dialog with form (slug pre-filled, version default `0.1.0`, description from manifest). Submit → `POST /api/local/:daemonId/publish-request`, on success show toast + invalidate catalog query.

Commit: `feat(dashboard): add /local page with inventory and publish flow`.

---

#### Task I3: `/catalog` page — list + filters

**Soubor:** `apps/dashboard/src/app/catalog/page.tsx`

**Test first** (vitest component): mocked `GET /api/artifacts` returns 3 items → table renders 3 rows. Type filter `skill` re-fetches with `?type=skill`. Search debounced 300ms.

UI: TanStack Query for `/api/artifacts`, search input + type select, table with columns Slug/Type/Description/Latest version/Published. Row click → `/catalog/[slug]`.

Commit: `feat(dashboard): add /catalog list page`.

---

#### Task I4: `/catalog/[slug]` detail with Install button

**Soubor:** `apps/dashboard/src/app/catalog/[slug]/page.tsx`

**Test first**: detail page shows artifact + version list, Install button calls `POST /api/install-request` with selected version + own daemonId.

UI: artifact metadata, versions table (latest non-deprecated highlighted), Install dropdown to pick daemon (default own first online), `[Install]` triggers POST with toast on success/failure.

Commit: `feat(dashboard): add catalog detail with install action`.

---

#### Task I5: Live `catalog.update` invalidation

**Test first**: open `/catalog`, simulate `catalog.update` WSS message → list refetches and contains new artifact.

Glue: subscribe to `catalog.update` in `useHubSocket` callback at app root, call `queryClient.invalidateQueries(['artifacts'])`.

Commit: `feat(dashboard): live catalog updates via WSS`.

---

### Sekce J — Integration & E2E tests

Cíl: end-to-end důkaz, že flow funguje napříč procesy.

#### Task J1: Server integration — publish round-trip

**Soubor:** `apps/hub-server/test/integration/publish-flow.test.ts`

Uses Testcontainers (Postgres + MinIO). Test flow: register user → login → POST `/api/artifacts/upload` with a real tar.gz → assert artifact + version rows exist → assert MinIO blob exists with same sha256 → GET `/api/artifacts/foo/versions/0.1.0/download` → fetch presigned URL → bytes match.

Commit: `test(server): add publish round-trip integration test`.

---

#### Task J2: Server integration — RBAC matrix

Test: member can yank own artifact, cannot yank others. Member cannot DELETE. Admin can. Member cannot upload `type=plugin` (returns 400 in MVP). Unauthenticated → 401 everywhere.

Commit: `test(server): add RBAC matrix tests for catalog endpoints`.

---

#### Task J3: Daemon integration — publish via local API

**Soubor:** `apps/agent/test/integration/publish_test.go`

Spins up `httptest` mock hub. Daemon scans temp `~/.claude/skills/foo`, POST `127.0.0.1:7878/v1/publish` → mock hub receives multipart with right fields, returns `{artifactId, versionId}`. Verify backup not made (publish doesn't touch local).

Commit: `test(agent): add local /v1/publish integration test`.

---

#### Task J4: Daemon integration — install round-trip

`httptest` hub serves a tar.gz at `/download`. POST `127.0.0.1:7878/v1/install` `{artifact_id, version}` → daemon downloads, extracts to `<tmpHome>/.claude/skills/foo`. Verify files. Repeat with existing dir → backup created. sha mismatch → returns error and dir untouched.

Commit: `test(agent): add local /v1/install integration test`.

---

#### Task J5: E2E — Playwright multi-context publish then install

**Soubor:** `e2e/publish-install.spec.ts`

Setup: `docker-compose up` for hub+postgres+minio (CI fixture). Two Playwright contexts, two mock daemons (Go binaries spawned in fixture, paired before test).

Steps:
1. Context A logs in, navigates to `/local`, publishes `skill:demo@0.1.0`.
2. Context A `/catalog` shows the artifact within 2s (WSS broadcast).
3. Context B logs in (different user, different daemon), navigates to `/catalog/demo`, clicks Install.
4. Context B `/local` shows `demo` skill within 2s.
5. Verify on disk: mock daemon B's home contains `.claude/skills/demo/SKILL.md`.

Commit: `test(e2e): add publish-install round-trip Playwright test`.

---

### Sekce K — Polish & wire-up

#### Task K1: Wire MinIO + WSS gateway into server bootstrap

`apps/hub-server/src/main.ts`: after migrations, `await bootstrapBucket()`, mount artifact routes, attach gateway upgrade handler. Smoke test: server starts in <2s, `/healthz` 200.

Commit: `chore(server): wire artifact catalog into main bootstrap`.

---

#### Task K2: Wire scanner registry + watcher + jobs into daemon bootstrap

`apps/agent/cmd/agent/main.go`: register `SkillScanner`, start watcher, attach WSS router with `Jobs{}` instance, attach local API publish/install/uninstall/toggle handlers. Smoke: daemon starts, pushes empty inventory snapshot, responds to ping.

Commit: `chore(agent): wire scanners, jobs, and local API in main`.

---

#### Task K3: Update README with Plan 3 capabilities

Add section "Skills publish/install" to root README with quick-start (login → install agent → pair → publish a skill from `/local` → install on another machine from `/catalog`).

Commit: `docs(readme): document skill publish/install flow`.

---

## Self-review

### Kontrola pokrytí specu
- [x] Spec §5.1 Postgres schema → Tasks A1, A2 — všechny tabulky `artifacts`, `artifact_versions`, `install_events` s FK, indexy, GIN nad manifest.
- [x] Spec §6.3 Publish from dashboard → Tasks H1, I2, F2, C1 — full flow Browser→Hub→Daemon→Hub→MinIO→Postgres→broadcast.
- [x] Spec §6.5 Install from dashboard → Tasks H2, I4, F3, C5 — full flow.
- [x] Spec §7.6 Daemon hardening (path whitelist, refuse `..`) → Task F3 explicitně testuje path-traversal.
- [x] Spec §7.7 Artifact integrity (sha256 client + server) → Task C1 server-side recompute, Task F3 client-side recompute.
- [x] Contracts §REST API → všech 6 endpointů + 2 broker endpointy implementováno (C1–C7, H1–H2).
- [x] Contracts §WSS protocol → všech 9 message typů (D1).

### Kontrola dependencies
- Předpokládá z Plan 1: `users`, `sessions`, `audit_log` schema, `requireAuth` middleware, `c.get('user')` typed, error JSON convention.
- Předpokládá z Plan 2: `daemons` table, `device_token` flow, WSS upgrade handler s rozdělením daemon/browser autentizace, `127.0.0.1:7878` server skeleton, `apps/agent/internal/api` types s `InventoryItem` strukturou, OS keychain access pro device token.
- Plan 4 dostane: `Scanner` interface, `Parser` interface, `ArtifactType` enum, `Jobs` struct s `parsers map[string]Parser` + `scanners map[string]Scanner`, kompletní WSS protokol — stačí přidat `PluginParser`, `CommandParser`, `AgentParser` a překlopit Scanner mapy.

### Kontrola TDD a granularity
- Každý z 33 tasků má explicitní "Test first" sekci s konkrétními assertions.
- Žádný task nemá víc než ~50 řádek kódu hlavní implementace; 2–5 min reálný odhad.
- Sekce I (dashboard) je největší, ale rozsekaná na 5 dílčích tasků s vlastními testy.

### Kontrola otevřených otázek
- **Slug collisions** (spec §10.1): řešeno v Task C1 — slug je hub-wide unique, second publish vrací `409 slug taken`.
- **`subscribe.local` autorizace**: server v Task D2 ověří, že browser session vlastní daný `daemonId` před přidáním do broadcast skupiny (RBAC test v J2).
- **Backup retention**: Task F3 vytváří `.claude-hub-backup/<slug>-<timestamp>/` ale nemá GC. To je akceptováno pro MVP a zaznamenáno jako follow-up; v Plan 4 ne, počká na v1.1.
- **Job timeout**: Task D5 30s default, Task H2 install 120s — install large blobs může trvat déle, takže delší timeout v broker endpointu, ne ve WSS jobs lib.
- **`targetPath` resolving `~`**: Task H2 posílá literal `~/.claude/skills/<slug>`; daemon expandne přes `os.UserHomeDir()` v Task F3. To je explicitně tested.

### Risks
- **MinIO presigned URLs cross-host**: pokud daemon běží mimo Docker network, `http://minio:9000` nedosáhne. Řešení: presigned URL musí používat veřejnou base URL (`PUBLIC_URL` + `/s3/`) — pre-Plan 3 se budeme spoléhat na Plan 1 reverse proxy. Pokud Plan 1 toto neřeší, přidat follow-up task ve sweep tasku K1.
- **fsnotify on Windows**: může mít edge case s atomic rename (editor vytvoří temp + rename). Task E3 testuje rapid changes coalescing; pokud na Windows nefunguje, padá na 2s polling fallback (přidat až po reálném failu, ne preemptivně).
- **WSS reconnect race**: pokud daemon reconnectne během běžícího jobu, hub má stale `pendingJobs` entry. Task D5 timeout 30s ho stejně vyčistí; v Plan 4 přidáme explicit cleanup on disconnect.
