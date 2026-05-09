# Artifact Catalog (Skill MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Postavit kompletní end-to-end flow **publish → catalog → install** pro typ artefaktu `skill`: scanner v daemonu detekuje obsah `~/.claude/skills/`, hub spravuje katalog (Postgres + MinIO), dashboard ukáže Local + Catalog stránky, a `Install` z katalogu doručí skill zpět na cílový stroj — to vše typově generické tak, aby Plan 4 doplnil pluginy/commandy/agenty bez zásahu do core flow.

**Architecture:** Server vrstva v `apps/hub-server` doplňuje `ArtifactType`-polymorfní drizzle schéma (`artifacts`, `artifact_versions`, `install_events`), MinIO klient přes `@aws-sdk/client-s3`, REST endpointy pod `/api/artifacts/*` + dva broker endpointy (`publish-request`, `install-request`) které přes WSS gateway delegují na daemona. WSS protokol v `packages/wss-protocol` rozšiřuje typovaný discriminated-union schéma o `inventory.snapshot/delta`, `job.install`, `job.package`, `job.toggle`, `local.snapshot/delta`, `catalog.update`. Daemon (`apps/agent`) implementuje `Scanner`/`ManifestParser` registry pattern (v Plan 3 jen `SkillScanner`+`SkillParser`), tar.gz packager s SHA-256, install job s path-traversal guardem a backup adresářem, a lokální HTTP API `/v1/{publish,install,uninstall,toggle}`. Dashboard (`apps/dashboard`) přidá `/local` a `/catalog` stránky live napojené na WSS přes `useHubSocket`.

**Tech Stack:**
- Server: Node.js 22, Hono 4, drizzle-orm + drizzle-kit, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, zod, nanoid, pino
- Daemon: Go 1.23, `archive/tar`, `compress/gzip`, `crypto/sha256`, `gopkg.in/yaml.v3`, `github.com/fsnotify/fsnotify`, `log/slog`
- Dashboard: Next.js 14 App Router, React 18, TanStack Query, TanStack Table, shadcn/ui Dialog/Toast
- Tests: Vitest + Testcontainers (Postgres + MinIO), `go test` + `httptest`, Playwright E2E
- Protocol: zod discriminated union TS source-of-truth, JSON Schema emit pro Go side

---

## Pořadí tasků a milníky

Tasky jsou seřazeny tematicky:

- **Sekce A (Tasks 1–3):** Database schema + MinIO klient
- **Sekce B (Tasks 4–5):** Validátory + manifest schema
- **Sekce C (Tasks 6–13):** REST API endpointy
- **Sekce D (Tasks 14–18):** WSS protocol extension + gateway
- **Sekce E (Tasks 19–22):** Daemon scanner + watcher
- **Sekce F (Tasks 23–26):** Daemon package + install jobs
- **Sekce G (Tasks 27–30):** Daemon local HTTP API
- **Sekce H (Tasks 31–32):** Server broker endpointy
- **Sekce I (Tasks 33–37):** Dashboard pages
- **Sekce J (Tasks 38–42):** Integration + E2E
- **Sekce K (Tasks 43–45):** Polish + wire-up

Each step ends with a verification command and a Conventional Commits message.

---

## Sekce A — Database & MinIO

### Task 1: Drizzle schema for artifacts, artifact_versions, install_events

**Files:**
- Create: `apps/hub-server/src/db/schema/artifacts.ts`
- Test: `apps/hub-server/src/db/schema/artifacts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { artifacts, artifactVersions, installEvents, artifactTypeEnum, installStatusEnum } from './artifacts';

describe('artifacts schema', () => {
  it('exposes artifact_type enum with 4 values', () => {
    expect(artifactTypeEnum.enumValues).toEqual(['skill', 'plugin', 'command', 'agent']);
  });
  it('exposes install_status enum with 3 values', () => {
    expect(installStatusEnum.enumValues).toEqual(['success', 'failed', 'rolled_back']);
  });
  it('artifacts.slug is notNull and unique', () => {
    expect(artifacts.slug.notNull).toBe(true);
    expect(artifacts.slug.isUnique).toBe(true);
  });
  it('artifact_versions has manifest jsonb column', () => {
    expect(artifactVersions.manifest.dataType).toBe('json');
  });
  it('install_events references daemons and artifact_versions', () => {
    expect(installEvents.daemonId.notNull).toBe(true);
    expect(installEvents.artifactVersionId.notNull).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run src/db/schema/artifacts.test.ts`
Expected: FAIL with "Cannot find module './artifacts'"

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  uuid,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { daemons } from './daemons';

export const artifactTypeEnum = pgEnum('artifact_type', ['skill', 'plugin', 'command', 'agent']);
export const installStatusEnum = pgEnum('install_status', ['success', 'failed', 'rolled_back']);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    type: artifactTypeEnum('type').notNull(),
    description: text('description').notNull().default(''),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    byType: index('artifacts_type_idx').on(t.type),
    byOwner: index('artifacts_owner_idx').on(t.ownerUserId),
  }),
);

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    manifest: jsonb('manifest').notNull(),
    publishedByUserId: uuid('published_by_user_id')
      .notNull()
      .references(() => users.id),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    deprecated: boolean('deprecated').notNull().default(false),
  },
  (t) => ({
    uqVersion: uniqueIndex('artifact_versions_artifact_version_uq').on(t.artifactId, t.version),
    byPublishedAt: index('artifact_versions_published_at_idx').on(t.publishedAt),
    manifestGin: index('artifact_versions_manifest_gin').using('gin', t.manifest),
  }),
);

export const installEvents = pgTable(
  'install_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    daemonId: uuid('daemon_id')
      .notNull()
      .references(() => daemons.id),
    artifactVersionId: uuid('artifact_version_id')
      .notNull()
      .references(() => artifactVersions.id),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
    status: installStatusEnum('status').notNull(),
  },
  (t) => ({
    byDaemon: index('install_events_daemon_idx').on(t.daemonId),
    byVersion: index('install_events_version_idx').on(t.artifactVersionId),
  }),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run src/db/schema/artifacts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/db/schema/artifacts.ts apps/hub-server/src/db/schema/artifacts.test.ts
git commit -m "feat(server): add drizzle schema for artifacts catalog"
```

---

### Task 2: Migration 0003_artifacts.sql

**Files:**
- Create: `ops/migrations/0003_artifacts.sql`
- Test: `apps/hub-server/test/integration/migrations-artifacts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { runMigrations } from '../../src/db/migrate';

describe('migration 0003_artifacts', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    sql = postgres(container.getConnectionUri());
    await runMigrations(container.getConnectionUri());
  }, 60_000);

  afterAll(async () => {
    await sql.end();
    await container.stop();
  });

  it('creates artifacts table', async () => {
    const [row] = await sql`SELECT to_regclass('artifacts') AS t`;
    expect(row.t).toBe('artifacts');
  });

  it('creates artifact_versions table', async () => {
    const [row] = await sql`SELECT to_regclass('artifact_versions') AS t`;
    expect(row.t).toBe('artifact_versions');
  });

  it('creates install_events table', async () => {
    const [row] = await sql`SELECT to_regclass('install_events') AS t`;
    expect(row.t).toBe('install_events');
  });

  it('creates GIN index on artifact_versions.manifest', async () => {
    const rows = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'artifact_versions'
        AND indexname = 'artifact_versions_manifest_gin'
    `;
    expect(rows).toHaveLength(1);
  });

  it('enforces unique (artifact_id, version)', async () => {
    const rows = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'artifact_versions'
        AND indexname = 'artifact_versions_artifact_version_uq'
    `;
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/migrations-artifacts.test.ts`
Expected: FAIL — table `artifacts` does not exist

- [ ] **Step 3: Generate and write migration**

Run: `pnpm --filter hub-server drizzle-kit generate --name artifacts`

Then verify the generated SQL at `ops/migrations/0003_artifacts.sql` contains:

```sql
-- 0003_artifacts.sql
CREATE TYPE "public"."artifact_type" AS ENUM('skill', 'plugin', 'command', 'agent');
CREATE TYPE "public"."install_status" AS ENUM('success', 'failed', 'rolled_back');

CREATE TABLE "artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "type" "artifact_type" NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "artifacts_slug_unique" UNIQUE("slug"),
  CONSTRAINT "artifacts_owner_user_id_users_id_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id")
);

CREATE TABLE "artifact_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "artifact_id" uuid NOT NULL,
  "version" text NOT NULL,
  "storage_key" text NOT NULL,
  "sha256" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "published_by_user_id" uuid NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deprecated" boolean DEFAULT false NOT NULL,
  CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk"
    FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE CASCADE,
  CONSTRAINT "artifact_versions_published_by_user_id_users_id_fk"
    FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id")
);

CREATE TABLE "install_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "daemon_id" uuid NOT NULL,
  "artifact_version_id" uuid NOT NULL,
  "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" "install_status" NOT NULL,
  CONSTRAINT "install_events_daemon_id_daemons_id_fk"
    FOREIGN KEY ("daemon_id") REFERENCES "public"."daemons"("id"),
  CONSTRAINT "install_events_artifact_version_id_artifact_versions_id_fk"
    FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id")
);

CREATE INDEX "artifacts_type_idx" ON "artifacts" ("type");
CREATE INDEX "artifacts_owner_idx" ON "artifacts" ("owner_user_id");
CREATE UNIQUE INDEX "artifact_versions_artifact_version_uq"
  ON "artifact_versions" ("artifact_id","version");
CREATE INDEX "artifact_versions_published_at_idx" ON "artifact_versions" ("published_at");
CREATE INDEX "artifact_versions_manifest_gin" ON "artifact_versions" USING gin ("manifest");
CREATE INDEX "install_events_daemon_idx" ON "install_events" ("daemon_id");
CREATE INDEX "install_events_version_idx" ON "install_events" ("artifact_version_id");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/migrations-artifacts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ops/migrations/0003_artifacts.sql apps/hub-server/test/integration/migrations-artifacts.test.ts
git commit -m "chore(db): add 0003 artifacts migration"
```

---

### Task 3: MinIO client wrapper

**Files:**
- Create: `apps/hub-server/src/storage/minio.ts`
- Test: `apps/hub-server/src/storage/minio.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { createHash } from 'node:crypto';
import {
  bootstrapBucket,
  putArtifactBlob,
  getArtifactBlobStream,
  presignDownload,
  storageKey,
  manifestKey,
} from './minio';

describe('minio storage', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer('minio/minio:RELEASE.2024-09-13T20-26-02Z')
      .withCommand(['server', '/data'])
      .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
      .withExposedPorts(9000)
      .start();
    process.env.MINIO_ENDPOINT = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    process.env.MINIO_ACCESS_KEY = 'minioadmin';
    process.env.MINIO_SECRET_KEY = 'minioadmin';
    process.env.MINIO_BUCKET = 'claude-hub-artifacts';
    await bootstrapBucket();
  }, 60_000);

  afterAll(async () => {
    await container.stop();
  });

  it('storageKey + manifestKey produce expected paths', () => {
    expect(storageKey('art-1', '0.1.0')).toBe('artifacts/art-1/0.1.0.tar.gz');
    expect(manifestKey('art-1', '0.1.0')).toBe('artifacts/art-1/0.1.0.manifest.json');
  });

  it('round-trips bytes through put + get', async () => {
    const bytes = Buffer.from('hello-hub');
    await putArtifactBlob('artifacts/test/0.1.0.tar.gz', bytes);
    const stream = await getArtifactBlobStream('artifacts/test/0.1.0.tar.gz');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello-hub');
  });

  it('presignDownload returns URL that downloads matching bytes', async () => {
    const bytes = Buffer.from('signed-bytes');
    await putArtifactBlob('artifacts/test/0.2.0.tar.gz', bytes);
    const url = await presignDownload('artifacts/test/0.2.0.tar.gz', 60);
    const resp = await fetch(url);
    const ab = await resp.arrayBuffer();
    expect(createHash('sha256').update(Buffer.from(ab)).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run src/storage/minio.test.ts`
Expected: FAIL with "Cannot find module './minio'"

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { env } from '../config/env';

export const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
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

export async function putArtifactBlob(
  key: string,
  body: Buffer | Readable,
  contentType = 'application/gzip',
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.MINIO_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getArtifactBlobStream(key: string): Promise<Readable> {
  const out = await s3.send(new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key }));
  return out.Body as Readable;
}

export async function presignDownload(key: string, ttlSec = 300): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key }),
    { expiresIn: ttlSec },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run src/storage/minio.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/storage/minio.ts apps/hub-server/src/storage/minio.test.ts
git commit -m "feat(server): add MinIO client wrapper with presigned download"
```

---

## Sekce B — Validators & manifest schema

### Task 4: Slug, semver, sha256, artifactType validators (Zod)

**Files:**
- Create: `apps/hub-server/src/lib/validators.ts`
- Test: `apps/hub-server/src/lib/validators.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { slugSchema, semverSchema, sha256Schema, artifactTypeSchema } from './validators';

describe('validators', () => {
  it('accepts valid slugs', () => {
    expect(slugSchema.parse('my-skill')).toBe('my-skill');
    expect(slugSchema.parse('a')).toBe('a');
    expect(slugSchema.parse('a-b-c-1-2-3')).toBe('a-b-c-1-2-3');
  });

  it('rejects invalid slugs', () => {
    expect(() => slugSchema.parse('My_Skill')).toThrow();
    expect(() => slugSchema.parse('-foo')).toThrow();
    expect(() => slugSchema.parse('foo bar')).toThrow();
    expect(() => slugSchema.parse('a'.repeat(65))).toThrow();
  });

  it('accepts strict MAJOR.MINOR.PATCH semver only', () => {
    expect(semverSchema.parse('1.0.0')).toBe('1.0.0');
    expect(() => semverSchema.parse('1.0')).toThrow();
    expect(() => semverSchema.parse('1.0.0-rc.1')).toThrow();
    expect(() => semverSchema.parse('v1.0.0')).toThrow();
  });

  it('accepts 64-hex sha256', () => {
    expect(sha256Schema.parse('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => sha256Schema.parse('abc')).toThrow();
    expect(() => sha256Schema.parse('Z'.repeat(64))).toThrow();
  });

  it('accepts the four artifact types', () => {
    for (const t of ['skill', 'plugin', 'command', 'agent'] as const) {
      expect(artifactTypeSchema.parse(t)).toBe(t);
    }
    expect(() => artifactTypeSchema.parse('mcp')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run src/lib/validators.test.ts`
Expected: FAIL with "Cannot find module './validators'"

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'invalid slug');

export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must be MAJOR.MINOR.PATCH');

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be 64 hex chars');

export const artifactTypeSchema = z.enum(['skill', 'plugin', 'command', 'agent']);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run src/lib/validators.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/lib/validators.ts apps/hub-server/src/lib/validators.test.ts
git commit -m "feat(server): add catalog input validators (slug, semver, sha256)"
```

---

### Task 5: ArtifactManifest Zod schema

**Files:**
- Create: `apps/hub-server/src/lib/manifest-schema.ts`
- Test: `apps/hub-server/src/lib/manifest-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { artifactManifestSchema } from './manifest-schema';

describe('artifactManifestSchema', () => {
  it('parses a minimal valid skill manifest', () => {
    const m = artifactManifestSchema.parse({
      schemaVersion: 1,
      name: 'foo',
      type: 'skill',
      description: 'helps with foo',
      typeMeta: {},
    });
    expect(m.name).toBe('foo');
    expect(m.type).toBe('skill');
  });

  it('defaults typeMeta to empty object', () => {
    const m = artifactManifestSchema.parse({
      schemaVersion: 1,
      name: 'foo',
      type: 'skill',
      description: 'helps',
    });
    expect(m.typeMeta).toEqual({});
  });

  it('rejects unknown type', () => {
    expect(() =>
      artifactManifestSchema.parse({
        schemaVersion: 1,
        name: 'foo',
        type: 'mcp',
        description: 'x',
      }),
    ).toThrow();
  });

  it('rejects missing name', () => {
    expect(() =>
      artifactManifestSchema.parse({
        schemaVersion: 1,
        type: 'skill',
        description: 'x',
      }),
    ).toThrow();
  });

  it('rejects empty description', () => {
    expect(() =>
      artifactManifestSchema.parse({
        schemaVersion: 1,
        name: 'foo',
        type: 'skill',
        description: '',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run src/lib/manifest-schema.test.ts`
Expected: FAIL with "Cannot find module './manifest-schema'"

- [ ] **Step 3: Write minimal implementation**

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
  signatures: z
    .array(
      z.object({
        algo: z.string(),
        keyId: z.string(),
        signature: z.string(),
      }),
    )
    .default([]),
});

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run src/lib/manifest-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/lib/manifest-schema.ts apps/hub-server/src/lib/manifest-schema.test.ts
git commit -m "feat(server): add ArtifactManifest schema with forward-compat signatures"
```

---

## Sekce C — REST API endpoints

### Task 6: POST /api/artifacts/upload — multipart handler

**Files:**
- Create: `apps/hub-server/src/routes/artifacts/upload.ts`
- Test: `apps/hub-server/test/integration/artifacts-upload.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs } from '../helpers/auth';

describe('POST /api/artifacts/upload', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); }, 90_000);
  afterAll(async () => { await srv.stop(); });

  async function uploadForm(opts: {
    cookie: string;
    slug: string; type: string; version: string;
    description: string; manifest: object;
    fileBytes: Buffer; sha256?: string;
  }) {
    const sha = opts.sha256 ?? createHash('sha256').update(opts.fileBytes).digest('hex');
    const form = new FormData();
    form.set('slug', opts.slug);
    form.set('type', opts.type);
    form.set('version', opts.version);
    form.set('description', opts.description);
    form.set('sha256', sha);
    form.set('manifest', JSON.stringify(opts.manifest));
    form.set('file', new Blob([opts.fileBytes], { type: 'application/gzip' }), 'a.tar.gz');
    return fetch(`${srv.url}/api/artifacts/upload`, {
      method: 'POST',
      headers: { cookie: opts.cookie },
      body: form,
    });
  }

  it('rejects unauthenticated', async () => {
    const r = await fetch(`${srv.url}/api/artifacts/upload`, { method: 'POST' });
    expect(r.status).toBe(401);
  });

  it('accepts a valid skill upload (201)', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const r = await uploadForm({
      cookie,
      slug: 'demo',
      type: 'skill',
      version: '0.1.0',
      description: 'demo skill',
      manifest: { schemaVersion: 1, name: 'demo', type: 'skill', description: 'demo skill', typeMeta: {} },
      fileBytes: Buffer.from('fake-targz'),
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.versionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects duplicate (slug, version)', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const m = { schemaVersion: 1, name: 'dup', type: 'skill', description: 'd', typeMeta: {} };
    const ok = await uploadForm({ cookie, slug: 'dup', type: 'skill', version: '0.1.0', description: 'd', manifest: m, fileBytes: Buffer.from('a') });
    expect(ok.status).toBe(201);
    const dupResp = await uploadForm({ cookie, slug: 'dup', type: 'skill', version: '0.1.0', description: 'd', manifest: m, fileBytes: Buffer.from('a') });
    expect(dupResp.status).toBe(409);
  });

  it('rejects non-skill type in MVP with 400', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const r = await uploadForm({
      cookie,
      slug: 'plug', type: 'plugin', version: '0.1.0', description: 'p',
      manifest: { schemaVersion: 1, name: 'plug', type: 'plugin', description: 'p', typeMeta: {} },
      fileBytes: Buffer.from('p'),
    });
    expect(r.status).toBe(400);
  });

  it('rejects sha256 mismatch', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const r = await uploadForm({
      cookie,
      slug: 'mismatch', type: 'skill', version: '0.1.0', description: 'm',
      manifest: { schemaVersion: 1, name: 'mismatch', type: 'skill', description: 'm', typeMeta: {} },
      fileBytes: Buffer.from('content'),
      sha256: 'a'.repeat(64),
    });
    expect(r.status).toBe(400);
  });

  it('rejects slug owned by another user with 409', async () => {
    const aliceCookie = await loginAs(srv, 'alice@example.com');
    const m = { schemaVersion: 1, name: 'shared', type: 'skill', description: 's', typeMeta: {} };
    const ok = await uploadForm({ cookie: aliceCookie, slug: 'shared', type: 'skill', version: '0.1.0', description: 's', manifest: m, fileBytes: Buffer.from('a') });
    expect(ok.status).toBe(201);
    const bobCookie = await loginAs(srv, 'bob@example.com');
    const r = await uploadForm({ cookie: bobCookie, slug: 'shared', type: 'skill', version: '0.2.0', description: 's', manifest: m, fileBytes: Buffer.from('b') });
    expect(r.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-upload.test.ts`
Expected: FAIL with 404 on POST /api/artifacts/upload

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { auditLog } from '../../db/schema/audit';
import { requireAuth } from '../../middleware/auth';
import {
  slugSchema,
  semverSchema,
  sha256Schema,
  artifactTypeSchema,
} from '../../lib/validators';
import { artifactManifestSchema } from '../../lib/manifest-schema';
import { storageKey, manifestKey, putArtifactBlob } from '../../storage/minio';
import { gateway } from '../../ws/gateway';

export const uploadRoute = new Hono().post('/upload', requireAuth, async (c) => {
  const form = await c.req.formData();
  const slug = slugSchema.parse(form.get('slug'));
  const type = artifactTypeSchema.parse(form.get('type'));
  if (type !== 'skill') {
    return c.json({ error: 'only skill supported in MVP' }, 400);
  }
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
  const existing = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.slug, slug))
    .limit(1);
  if (existing[0] && existing[0].ownerUserId !== user.id) {
    return c.json({ error: 'slug taken' }, 409);
  }

  return await db.transaction(async (tx) => {
    let artifactId: string;
    if (existing[0]) {
      artifactId = existing[0].id;
      const dup = await tx
        .select()
        .from(artifactVersions)
        .where(
          and(
            eq(artifactVersions.artifactId, artifactId),
            eq(artifactVersions.version, version),
          ),
        )
        .limit(1);
      if (dup[0]) return c.json({ error: 'version exists' }, 409);
    } else {
      const [a] = await tx
        .insert(artifacts)
        .values({ slug, type, description, ownerUserId: user.id })
        .returning();
      artifactId = a.id;
    }
    const sk = storageKey(artifactId, version);
    await putArtifactBlob(sk, buf);
    await putArtifactBlob(
      manifestKey(artifactId, version),
      Buffer.from(JSON.stringify(manifest)),
      'application/json',
    );
    const [v] = await tx
      .insert(artifactVersions)
      .values({
        artifactId,
        version,
        storageKey: sk,
        sha256,
        manifest,
        publishedByUserId: user.id,
      })
      .returning();
    await tx.insert(auditLog).values({
      actorUserId: user.id,
      action: 'artifact.publish',
      targetType: 'artifact_version',
      targetId: v.id,
      payload: { slug, version },
    });
    gateway.broadcastAll({
      type: 'catalog.update',
      id: nanoid(),
      payload: { artifactId, slug, type, version },
    });
    return c.json({ artifactId, versionId: v.id }, 201);
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-upload.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/artifacts/upload.ts apps/hub-server/test/integration/artifacts-upload.test.ts
git commit -m "feat(server): add POST /api/artifacts/upload with sha256 + RBAC"
```

---

### Task 7: GET /api/artifacts — list with filters

**Files:**
- Create: `apps/hub-server/src/routes/artifacts/list.ts`
- Test: `apps/hub-server/test/integration/artifacts-list.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, seedArtifact } from '../helpers/auth';

describe('GET /api/artifacts', () => {
  let srv: TestServer;
  let cookie: string;
  beforeAll(async () => {
    srv = await startTestServer();
    cookie = await loginAs(srv, 'alice@example.com');
    await seedArtifact(srv, cookie, { slug: 'helper-a', type: 'skill', description: 'helper one', version: '0.1.0' });
    await seedArtifact(srv, cookie, { slug: 'helper-b', type: 'skill', description: 'another helper', version: '0.1.0' });
    await seedArtifact(srv, cookie, { slug: 'plug-a',   type: 'plugin', description: 'plugin one',  version: '0.1.0' });
  }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('rejects unauthenticated', async () => {
    const r = await fetch(`${srv.url}/api/artifacts`);
    expect(r.status).toBe(401);
  });

  it('returns all non-archived artifacts by default', async () => {
    const r = await fetch(`${srv.url}/api/artifacts`, { headers: { cookie } });
    const body = await r.json();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
  });

  it('filters by type', async () => {
    const r = await fetch(`${srv.url}/api/artifacts?type=skill`, { headers: { cookie } });
    const body = await r.json();
    expect(body.total).toBe(2);
    expect(body.items.every((i: { type: string }) => i.type === 'skill')).toBe(true);
  });

  it('filters by description ILIKE q', async () => {
    const r = await fetch(`${srv.url}/api/artifacts?q=helper`, { headers: { cookie } });
    const body = await r.json();
    expect(body.total).toBe(2);
  });

  it('paginates with limit and page', async () => {
    const r = await fetch(`${srv.url}/api/artifacts?page=1&limit=1`, { headers: { cookie } });
    const body = await r.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-list.test.ts`
Expected: FAIL with 404 on GET /api/artifacts

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { requireAuth } from '../../middleware/auth';
import { artifactTypeSchema } from '../../lib/validators';

const querySchema = z.object({
  type: artifactTypeSchema.optional(),
  q: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listRoute = new Hono().get('/', requireAuth, async (c) => {
  const params = Object.fromEntries(new URL(c.req.url).searchParams);
  const { type, q, page, limit } = querySchema.parse(params);
  const conds = [isNull(artifacts.archivedAt)];
  if (type) conds.push(eq(artifacts.type, type));
  if (q) conds.push(ilike(artifacts.description, `%${q}%`));
  const where = and(...conds);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(where);

  const rows = await db
    .select({
      id: artifacts.id,
      slug: artifacts.slug,
      type: artifacts.type,
      description: artifacts.description,
      ownerUserId: artifacts.ownerUserId,
      createdAt: artifacts.createdAt,
      archivedAt: artifacts.archivedAt,
      latestVersion: sql<string | null>`(
        SELECT version FROM ${artifactVersions} av
        WHERE av.artifact_id = ${artifacts.id} AND av.deprecated = false
        ORDER BY string_to_array(av.version, '.')::int[] DESC
        LIMIT 1
      )`,
    })
    .from(artifacts)
    .where(where)
    .orderBy(desc(artifacts.createdAt))
    .limit(limit)
    .offset((page - 1) * limit);

  return c.json({ items: rows, page, limit, total: count });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-list.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/artifacts/list.ts apps/hub-server/test/integration/artifacts-list.test.ts
git commit -m "feat(server): add GET /api/artifacts list with type/q filters"
```

---

### Task 8: GET /api/artifacts/:slug — detail with versions

**Files:**
- Create: `apps/hub-server/src/routes/artifacts/detail.ts`
- Test: `apps/hub-server/test/integration/artifacts-detail.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, seedArtifact, yankArtifactVersions } from '../helpers/auth';

describe('GET /api/artifacts/:slug', () => {
  let srv: TestServer;
  let cookie: string;
  beforeAll(async () => {
    srv = await startTestServer();
    cookie = await loginAs(srv, 'alice@example.com');
    await seedArtifact(srv, cookie, { slug: 'multi', type: 'skill', description: 'd', version: '0.1.0' });
    await seedArtifact(srv, cookie, { slug: 'multi', type: 'skill', description: 'd', version: '0.2.0' });
    await yankArtifactVersions(srv, cookie, 'multi', ['0.1.0']);
  }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('404 on unknown slug', async () => {
    const r = await fetch(`${srv.url}/api/artifacts/missing`, { headers: { cookie } });
    expect(r.status).toBe(404);
  });

  it('returns artifact + versions sorted desc by publishedAt', async () => {
    const r = await fetch(`${srv.url}/api/artifacts/multi`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.artifact.slug).toBe('multi');
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].version).toBe('0.2.0');
    expect(body.versions[1].deprecated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-detail.test.ts`
Expected: FAIL with 404 on detail endpoint

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { requireAuth } from '../../middleware/auth';
import { slugSchema } from '../../lib/validators';

export const detailRoute = new Hono().get('/:slug', requireAuth, async (c) => {
  const slug = slugSchema.parse(c.req.param('slug'));
  const [a] = await db.select().from(artifacts).where(eq(artifacts.slug, slug)).limit(1);
  if (!a) return c.json({ error: 'not found' }, 404);
  const versions = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, a.id))
    .orderBy(desc(artifactVersions.publishedAt));
  return c.json({ artifact: a, versions });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-detail.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/artifacts/detail.ts apps/hub-server/test/integration/artifacts-detail.test.ts
git commit -m "feat(server): add GET /api/artifacts/:slug detail endpoint"
```

---

### Task 9: GET /api/artifacts/:slug/versions/:version

**Files:**
- Create: `apps/hub-server/src/routes/artifacts/version-detail.ts`
- Test: `apps/hub-server/test/integration/artifacts-version-detail.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, seedArtifact } from '../helpers/auth';

describe('GET /api/artifacts/:slug/versions/:version', () => {
  let srv: TestServer;
  let cookie: string;
  beforeAll(async () => {
    srv = await startTestServer();
    cookie = await loginAs(srv, 'alice@example.com');
    await seedArtifact(srv, cookie, { slug: 'verd', type: 'skill', description: 'd', version: '0.1.0' });
  }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('returns version with embedded manifest', async () => {
    const r = await fetch(`${srv.url}/api/artifacts/verd/versions/0.1.0`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.version).toBe('0.1.0');
    expect(body.manifest.name).toBe('verd');
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('404 on unknown version', async () => {
    const r = await fetch(`${srv.url}/api/artifacts/verd/versions/9.9.9`, { headers: { cookie } });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-version-detail.test.ts`
Expected: FAIL with 404 on version detail endpoint

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { requireAuth } from '../../middleware/auth';
import { slugSchema, semverSchema } from '../../lib/validators';

export const versionDetailRoute = new Hono().get(
  '/:slug/versions/:version',
  requireAuth,
  async (c) => {
    const slug = slugSchema.parse(c.req.param('slug'));
    const version = semverSchema.parse(c.req.param('version'));
    const [row] = await db
      .select()
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(and(eq(artifacts.slug, slug), eq(artifactVersions.version, version)))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(row.artifact_versions);
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-version-detail.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/artifacts/version-detail.ts apps/hub-server/test/integration/artifacts-version-detail.test.ts
git commit -m "feat(server): add GET artifact version detail endpoint"
```

---

### Task 10: GET /api/artifacts/:slug/versions/:version/download — presigned

**Files:**
- Create: `apps/hub-server/src/routes/artifacts/download.ts`
- Test: `apps/hub-server/test/integration/artifacts-download.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, seedArtifact } from '../helpers/auth';

describe('GET /api/artifacts/:slug/versions/:version/download', () => {
  let srv: TestServer;
  let cookie: string;
  let expectedSha: string;
  beforeAll(async () => {
    srv = await startTestServer();
    cookie = await loginAs(srv, 'alice@example.com');
    const seeded = await seedArtifact(srv, cookie, {
      slug: 'dl', type: 'skill', description: 'd', version: '0.1.0',
      fileBytes: Buffer.from('hello-download-bytes'),
    });
    expectedSha = seeded.sha256;
  }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('returns presigned URL + sha256', async () => {
    const r = await fetch(`${srv.url}/api/artifacts/dl/versions/0.1.0/download`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.sha256).toBe(expectedSha);
    expect(body.downloadUrl).toMatch(/X-Amz-Signature=/);

    const fileResp = await fetch(body.downloadUrl);
    const buf = Buffer.from(await fileResp.arrayBuffer());
    expect(createHash('sha256').update(buf).digest('hex')).toBe(expectedSha);
  });

  it('404 on unknown', async () => {
    const r = await fetch(`${srv.url}/api/artifacts/dl/versions/9.9.9/download`, { headers: { cookie } });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-download.test.ts`
Expected: FAIL with 404 on download endpoint

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { requireAuth } from '../../middleware/auth';
import { slugSchema, semverSchema } from '../../lib/validators';
import { presignDownload } from '../../storage/minio';

export const downloadRoute = new Hono().get(
  '/:slug/versions/:version/download',
  requireAuth,
  async (c) => {
    const slug = slugSchema.parse(c.req.param('slug'));
    const version = semverSchema.parse(c.req.param('version'));
    const [row] = await db
      .select({
        key: artifactVersions.storageKey,
        sha: artifactVersions.sha256,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(and(eq(artifacts.slug, slug), eq(artifactVersions.version, version)))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    const url = await presignDownload(row.key, 300);
    return c.json({ downloadUrl: url, sha256: row.sha });
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-download.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/artifacts/download.ts apps/hub-server/test/integration/artifacts-download.test.ts
git commit -m "feat(server): add presigned download endpoint with sha256"
```

---

### Task 11: POST /api/artifacts/:slug/yank — owner or admin

**Files:**
- Create: `apps/hub-server/src/routes/artifacts/yank.ts`
- Test: `apps/hub-server/test/integration/artifacts-yank.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, seedArtifact, promoteToAdmin } from '../helpers/auth';

describe('POST /api/artifacts/:slug/yank', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('owner can yank own artifact', async () => {
    const ck = await loginAs(srv, 'owner@example.com');
    await seedArtifact(srv, ck, { slug: 'mine', type: 'skill', description: 'd', version: '0.1.0' });
    const r = await fetch(`${srv.url}/api/artifacts/mine/yank`, { method: 'POST', headers: { cookie: ck } });
    expect(r.status).toBe(200);

    const det = await fetch(`${srv.url}/api/artifacts/mine`, { headers: { cookie: ck } });
    const body = await det.json();
    expect(body.versions.every((v: { deprecated: boolean }) => v.deprecated)).toBe(true);
  });

  it('non-owner member receives 403', async () => {
    const owner = await loginAs(srv, 'o2@example.com');
    await seedArtifact(srv, owner, { slug: 'theirs', type: 'skill', description: 'd', version: '0.1.0' });
    const other = await loginAs(srv, 'other@example.com');
    const r = await fetch(`${srv.url}/api/artifacts/theirs/yank`, { method: 'POST', headers: { cookie: other } });
    expect(r.status).toBe(403);
  });

  it('admin can yank any artifact', async () => {
    const owner = await loginAs(srv, 'o3@example.com');
    await seedArtifact(srv, owner, { slug: 'admyank', type: 'skill', description: 'd', version: '0.1.0' });
    await promoteToAdmin(srv, 'admin@example.com');
    const adm = await loginAs(srv, 'admin@example.com');
    const r = await fetch(`${srv.url}/api/artifacts/admyank/yank`, { method: 'POST', headers: { cookie: adm } });
    expect(r.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-yank.test.ts`
Expected: FAIL with 404 on yank endpoint

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { artifacts, artifactVersions } from '../../db/schema/artifacts';
import { auditLog } from '../../db/schema/audit';
import { requireAuth } from '../../middleware/auth';
import { slugSchema } from '../../lib/validators';

export const yankRoute = new Hono().post('/:slug/yank', requireAuth, async (c) => {
  const slug = slugSchema.parse(c.req.param('slug'));
  const user = c.get('user');
  const [a] = await db.select().from(artifacts).where(eq(artifacts.slug, slug)).limit(1);
  if (!a) return c.json({ error: 'not found' }, 404);
  if (a.ownerUserId !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  await db
    .update(artifactVersions)
    .set({ deprecated: true })
    .where(eq(artifactVersions.artifactId, a.id));
  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: 'artifact.yank',
    targetType: 'artifact',
    targetId: a.id,
    payload: { slug },
  });
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-yank.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/artifacts/yank.ts apps/hub-server/test/integration/artifacts-yank.test.ts
git commit -m "feat(server): add yank endpoint with owner/admin RBAC"
```

---

### Task 12: DELETE /api/artifacts/:slug — admin archive

**Files:**
- Create: `apps/hub-server/src/routes/artifacts/archive.ts`
- Test: `apps/hub-server/test/integration/artifacts-archive.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, seedArtifact, promoteToAdmin } from '../helpers/auth';

describe('DELETE /api/artifacts/:slug', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('member receives 403', async () => {
    const owner = await loginAs(srv, 'a@example.com');
    await seedArtifact(srv, owner, { slug: 'memarc', type: 'skill', description: 'd', version: '0.1.0' });
    const r = await fetch(`${srv.url}/api/artifacts/memarc`, { method: 'DELETE', headers: { cookie: owner } });
    expect(r.status).toBe(403);
  });

  it('admin can archive; archived rows excluded from list', async () => {
    const owner = await loginAs(srv, 'b@example.com');
    await seedArtifact(srv, owner, { slug: 'admarc', type: 'skill', description: 'd', version: '0.1.0' });
    await promoteToAdmin(srv, 'admin2@example.com');
    const adm = await loginAs(srv, 'admin2@example.com');
    const r = await fetch(`${srv.url}/api/artifacts/admarc`, { method: 'DELETE', headers: { cookie: adm } });
    expect(r.status).toBe(200);

    const list = await fetch(`${srv.url}/api/artifacts`, { headers: { cookie: adm } });
    const body = await list.json();
    expect(body.items.find((i: { slug: string }) => i.slug === 'admarc')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-archive.test.ts`
Expected: FAIL with 404 on DELETE

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { artifacts } from '../../db/schema/artifacts';
import { auditLog } from '../../db/schema/audit';
import { requireAuth } from '../../middleware/auth';
import { slugSchema } from '../../lib/validators';

export const archiveRoute = new Hono().delete('/:slug', requireAuth, async (c) => {
  const slug = slugSchema.parse(c.req.param('slug'));
  const user = c.get('user');
  if (user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  const [a] = await db.select().from(artifacts).where(eq(artifacts.slug, slug)).limit(1);
  if (!a) return c.json({ error: 'not found' }, 404);
  await db.update(artifacts).set({ archivedAt: new Date() }).where(eq(artifacts.id, a.id));
  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: 'artifact.archive',
    targetType: 'artifact',
    targetId: a.id,
    payload: { slug },
  });
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-archive.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/artifacts/archive.ts apps/hub-server/test/integration/artifacts-archive.test.ts
git commit -m "feat(server): add admin DELETE /api/artifacts/:slug archive endpoint"
```

---

### Task 13: Mount artifact routes + RBAC sweep

**Files:**
- Modify: `apps/hub-server/src/routes/index.ts`
- Test: `apps/hub-server/test/integration/artifacts-rbac-sweep.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';

describe('artifacts routes RBAC sweep', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); }, 90_000);
  afterAll(async () => { await srv.stop(); });

  const endpoints = [
    { method: 'GET', path: '/api/artifacts' },
    { method: 'GET', path: '/api/artifacts/foo' },
    { method: 'POST', path: '/api/artifacts/upload' },
    { method: 'POST', path: '/api/artifacts/foo/yank' },
    { method: 'DELETE', path: '/api/artifacts/foo' },
    { method: 'GET', path: '/api/artifacts/foo/versions/0.1.0' },
    { method: 'GET', path: '/api/artifacts/foo/versions/0.1.0/download' },
  ] as const;

  it.each(endpoints)('returns 401 unauthenticated for $method $path', async ({ method, path }) => {
    const r = await fetch(`${srv.url}${path}`, { method });
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-rbac-sweep.test.ts`
Expected: FAIL — at least one route returns 404 instead of 401

- [ ] **Step 3: Mount routes in router index**

```ts
// SPDX-License-Identifier: Apache-2.0
// apps/hub-server/src/routes/index.ts
import { Hono } from 'hono';
import { uploadRoute } from './artifacts/upload';
import { listRoute } from './artifacts/list';
import { detailRoute } from './artifacts/detail';
import { versionDetailRoute } from './artifacts/version-detail';
import { downloadRoute } from './artifacts/download';
import { yankRoute } from './artifacts/yank';
import { archiveRoute } from './artifacts/archive';

export const artifactsRouter = new Hono()
  .route('/', uploadRoute)
  .route('/', listRoute)
  .route('/', detailRoute)
  .route('/', versionDetailRoute)
  .route('/', downloadRoute)
  .route('/', yankRoute)
  .route('/', archiveRoute);

// in apps/hub-server/src/main.ts router setup:
//   app.route('/api/artifacts', artifactsRouter);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/artifacts-rbac-sweep.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/index.ts apps/hub-server/test/integration/artifacts-rbac-sweep.test.ts
git commit -m "feat(server): mount artifact routes and verify auth on every endpoint"
```

---

## Sekce D — WSS protocol extension + gateway

### Task 14: Extend wss-protocol with discriminated union of new messages

**Files:**
- Modify: `packages/wss-protocol/src/messages.ts`
- Test: `packages/wss-protocol/src/messages.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { parseMessage, wssMessageSchema } from './messages';

describe('wss messages', () => {
  it('parses inventory.snapshot', () => {
    const m = parseMessage({
      type: 'inventory.snapshot',
      id: 'r1',
      payload: { items: [{ type: 'skill', slug: 'foo', version: null, path: '/x', enabled: null }] },
    });
    expect(m.type).toBe('inventory.snapshot');
  });

  it('parses job.install with required fields', () => {
    const m = parseMessage({
      type: 'job.install',
      id: 'r2',
      payload: {
        requestId: 'req-1',
        artifactVersionId: 'av-1',
        type: 'skill',
        slug: 'foo',
        version: '0.1.0',
        sha256: 'a'.repeat(64),
        downloadUrl: 'https://example/foo.tar.gz',
        targetPath: '~/.claude/skills/foo',
      },
    });
    expect(m.type).toBe('job.install');
  });

  it('parses job.toggle (plugin only flag carrier)', () => {
    const m = parseMessage({
      type: 'job.toggle',
      id: 'r3',
      payload: { requestId: 'rq', artifactId: 'a-1', slug: 'pl', enabled: true },
    });
    expect(m.type).toBe('job.toggle');
  });

  it('parses subscribe.local + local.snapshot + local.delta + catalog.update', () => {
    expect(parseMessage({ type: 'subscribe.local', id: 's1', payload: { daemonId: 'd-1' } }).type).toBe('subscribe.local');
    expect(parseMessage({
      type: 'local.snapshot', id: 's2',
      payload: { daemonId: 'd-1', items: [] },
    }).type).toBe('local.snapshot');
    expect(parseMessage({
      type: 'local.delta', id: 's3',
      payload: { daemonId: 'd-1', added: [], removed: [], modified: [] },
    }).type).toBe('local.delta');
    expect(parseMessage({
      type: 'catalog.update', id: 's4',
      payload: { artifactId: 'a-1', slug: 'foo', type: 'skill', version: '0.1.0' },
    }).type).toBe('catalog.update');
  });

  it('rejects unknown type', () => {
    expect(() => parseMessage({ type: 'job.enable', id: 'x', payload: {} })).toThrow();
  });

  it('rejects job.install missing requestId', () => {
    expect(() =>
      parseMessage({
        type: 'job.install',
        id: 'r4',
        payload: {
          artifactVersionId: 'av-1', type: 'skill', slug: 'foo', version: '0.1.0',
          sha256: 'a'.repeat(64), downloadUrl: 'u', targetPath: '~/.claude/skills/foo',
        },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hub/wss-protocol vitest run src/messages.test.ts`
Expected: FAIL — current schema does not include the new message variants

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const artifactTypeWireSchema = z.enum(['skill', 'plugin', 'command', 'agent']);

export const inventoryItemSchema = z.object({
  type: artifactTypeWireSchema,
  slug: z.string(),
  version: z.string().nullable(),
  path: z.string(),
  enabled: z.boolean().nullable(),
  publishedAs: z
    .object({ artifactId: z.string(), version: z.string() })
    .optional(),
});

export const wssMessageSchema = z.discriminatedUnion('type', [
  // Daemon → Hub
  z.object({
    type: z.literal('inventory.snapshot'),
    id: z.string(),
    payload: z.object({ items: z.array(inventoryItemSchema) }),
  }),
  z.object({
    type: z.literal('inventory.delta'),
    id: z.string(),
    payload: z.object({
      added: z.array(inventoryItemSchema).default([]),
      removed: z
        .array(z.object({ type: artifactTypeWireSchema, slug: z.string() }))
        .default([]),
      modified: z.array(inventoryItemSchema).default([]),
    }),
  }),
  z.object({
    type: z.literal('job.result'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      data: z.record(z.unknown()).optional(),
    }),
  }),
  z.object({ type: z.literal('pong'), id: z.string(), payload: z.object({}) }),

  // Hub → Daemon
  z.object({
    type: z.literal('job.install'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      artifactVersionId: z.string(),
      type: artifactTypeWireSchema,
      slug: z.string(),
      version: z.string(),
      sha256: z.string(),
      downloadUrl: z.string(),
      targetPath: z.string(),
    }),
  }),
  z.object({
    type: z.literal('job.uninstall'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      artifactId: z.string(),
      slug: z.string(),
      type: artifactTypeWireSchema,
    }),
  }),
  z.object({
    type: z.literal('job.toggle'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      artifactId: z.string(),
      slug: z.string(),
      enabled: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('job.package'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      slug: z.string(),
      type: artifactTypeWireSchema,
      version: z.string(),
      description: z.string(),
      sourcePath: z.string(),
    }),
  }),
  z.object({ type: z.literal('ping'), id: z.string(), payload: z.object({}) }),

  // Dashboard ↔ Hub
  z.object({
    type: z.literal('subscribe.local'),
    id: z.string(),
    payload: z.object({ daemonId: z.string() }),
  }),
  z.object({
    type: z.literal('local.snapshot'),
    id: z.string(),
    payload: z.object({
      daemonId: z.string(),
      items: z.array(inventoryItemSchema),
    }),
  }),
  z.object({
    type: z.literal('local.delta'),
    id: z.string(),
    payload: z.object({
      daemonId: z.string(),
      added: z.array(inventoryItemSchema).default([]),
      removed: z
        .array(z.object({ type: artifactTypeWireSchema, slug: z.string() }))
        .default([]),
      modified: z.array(inventoryItemSchema).default([]),
    }),
  }),
  z.object({
    type: z.literal('catalog.update'),
    id: z.string(),
    payload: z.object({
      artifactId: z.string(),
      slug: z.string(),
      type: artifactTypeWireSchema,
      version: z.string(),
    }),
  }),
]);

export type WssMessage = z.infer<typeof wssMessageSchema>;
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

export function parseMessage(raw: unknown): WssMessage {
  return wssMessageSchema.parse(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hub/wss-protocol vitest run src/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/wss-protocol/src/messages.ts packages/wss-protocol/src/messages.test.ts
git commit -m "feat(protocol): extend WSS messages for jobs, inventory, dashboard subscriptions"
```

---

### Task 15: Emit JSON Schema for Go side from zod source

**Files:**
- Create: `packages/wss-protocol/scripts/emit-jsonschema.ts`
- Create: `packages/wss-protocol/dist/messages.schema.json` (generated)
- Test: `packages/wss-protocol/scripts/emit-jsonschema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitJsonSchema } from './emit-jsonschema';

describe('emitJsonSchema', () => {
  it('writes a JSON Schema file with all 12 message types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wss-'));
    const out = join(dir, 'schema.json');
    emitJsonSchema(out);
    const schema = JSON.parse(readFileSync(out, 'utf-8'));
    const types: string[] = schema.definitions.WssMessage.anyOf.map(
      (variant: { properties: { type: { const: string } } }) => variant.properties.type.const,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'inventory.snapshot', 'inventory.delta', 'job.result', 'pong',
        'job.install', 'job.uninstall', 'job.toggle', 'job.package', 'ping',
        'subscribe.local', 'local.snapshot', 'local.delta', 'catalog.update',
      ]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hub/wss-protocol vitest run scripts/emit-jsonschema.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { wssMessageSchema } from '../src/messages';

export function emitJsonSchema(outPath: string): void {
  const schema = zodToJsonSchema(wssMessageSchema, 'WssMessage');
  writeFileSync(outPath, JSON.stringify(schema, null, 2), 'utf-8');
}

if (process.argv[1]?.endsWith('emit-jsonschema.ts')) {
  emitJsonSchema(process.argv[2] ?? 'dist/messages.schema.json');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hub/wss-protocol vitest run scripts/emit-jsonschema.test.ts`
Expected: PASS

Then generate the canonical schema for Go consumers:

Run: `pnpm --filter @hub/wss-protocol exec tsx scripts/emit-jsonschema.ts dist/messages.schema.json`

- [ ] **Step 5: Commit**

```bash
git add packages/wss-protocol/scripts/emit-jsonschema.ts packages/wss-protocol/scripts/emit-jsonschema.test.ts packages/wss-protocol/dist/messages.schema.json
git commit -m "feat(protocol): emit JSON Schema for Go-side validation"
```

---

### Task 16: WSS gateway — split daemon vs browser pools + subscription registry

**Files:**
- Create: `apps/hub-server/src/ws/gateway.ts`
- Test: `apps/hub-server/src/ws/gateway.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from './gateway';

class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

describe('Gateway', () => {
  let gw: Gateway;
  beforeEach(() => { gw = new Gateway(); });

  it('registers daemon and retrieves socket by daemonId', () => {
    const s = new FakeSocket() as unknown as WebSocket;
    gw.registerDaemon('d-1', s);
    expect(gw.getDaemonSocket('d-1')).toBe(s);
  });

  it('registers browser session and routes subscribe.local', () => {
    const s = new FakeSocket() as unknown as WebSocket;
    gw.registerBrowser('sess-1', 'user-1', s);
    gw.subscribeBrowserToDaemon('sess-1', 'd-1');
    const subs = gw.getBrowserSubscribers('d-1');
    expect(subs).toContain(s);
  });

  it('removes daemon and browser on disconnect', () => {
    const ds = new FakeSocket() as unknown as WebSocket;
    const bs = new FakeSocket() as unknown as WebSocket;
    gw.registerDaemon('d-2', ds);
    gw.registerBrowser('sess-2', 'user-2', bs);
    gw.subscribeBrowserToDaemon('sess-2', 'd-2');
    gw.disconnectDaemon('d-2');
    gw.disconnectBrowser('sess-2');
    expect(gw.getDaemonSocket('d-2')).toBeUndefined();
    expect(gw.getBrowserSubscribers('d-2')).toHaveLength(0);
  });

  it('broadcastAll sends to every browser', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    gw.registerBrowser('s-a', 'u-a', a as unknown as WebSocket);
    gw.registerBrowser('s-b', 'u-b', b as unknown as WebSocket);
    gw.broadcastAll({ type: 'catalog.update', id: 'x', payload: { artifactId: 'a', slug: 's', type: 'skill', version: '0.1.0' } });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run src/ws/gateway.test.ts`
Expected: FAIL — Cannot find module './gateway'

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import type { WssMessage } from '@hub/wss-protocol';

export class Gateway {
  private daemons = new Map<string, WebSocket>();
  private browsers = new Map<string, { userId: string; socket: WebSocket }>();
  private subscriptions = new Map<string, Set<string>>(); // daemonId -> Set<sessionId>

  registerDaemon(daemonId: string, socket: WebSocket): void {
    this.daemons.set(daemonId, socket);
  }

  getDaemonSocket(daemonId: string): WebSocket | undefined {
    return this.daemons.get(daemonId);
  }

  disconnectDaemon(daemonId: string): void {
    this.daemons.delete(daemonId);
  }

  registerBrowser(sessionId: string, userId: string, socket: WebSocket): void {
    this.browsers.set(sessionId, { userId, socket });
  }

  disconnectBrowser(sessionId: string): void {
    this.browsers.delete(sessionId);
    for (const subs of this.subscriptions.values()) subs.delete(sessionId);
  }

  subscribeBrowserToDaemon(sessionId: string, daemonId: string): void {
    let set = this.subscriptions.get(daemonId);
    if (!set) {
      set = new Set();
      this.subscriptions.set(daemonId, set);
    }
    set.add(sessionId);
  }

  getBrowserSubscribers(daemonId: string): WebSocket[] {
    const sessIds = this.subscriptions.get(daemonId);
    if (!sessIds) return [];
    const out: WebSocket[] = [];
    for (const sid of sessIds) {
      const b = this.browsers.get(sid);
      if (b) out.push(b.socket);
    }
    return out;
  }

  broadcastToSubscribers(daemonId: string, msg: WssMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.getBrowserSubscribers(daemonId)) {
      if (s.readyState === 1) s.send(data);
    }
  }

  broadcastAll(msg: WssMessage): void {
    const data = JSON.stringify(msg);
    for (const { socket } of this.browsers.values()) {
      if (socket.readyState === 1) socket.send(data);
    }
  }
}

export const gateway = new Gateway();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run src/ws/gateway.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/ws/gateway.ts apps/hub-server/src/ws/gateway.test.ts
git commit -m "feat(server): split WSS registry into daemon and browser pools"
```

---

### Task 17: Inventory broadcast — daemon snapshot/delta to subscribers

**Files:**
- Create: `apps/hub-server/src/ws/inventory.ts`
- Test: `apps/hub-server/src/ws/inventory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from './gateway';
import { handleDaemonMessage, getDaemonInventory } from './inventory';

class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  send(d: string) { this.sent.push(d); }
}

describe('inventory broadcast', () => {
  let gw: Gateway;
  beforeEach(() => { gw = new Gateway(); });

  it('caches snapshot and broadcasts local.snapshot to subscribers', () => {
    const browser = new FakeSocket();
    gw.registerBrowser('s1', 'u1', browser as unknown as WebSocket);
    gw.subscribeBrowserToDaemon('s1', 'd-1');
    handleDaemonMessage(gw, 'd-1', {
      type: 'inventory.snapshot',
      id: 'i1',
      payload: { items: [{ type: 'skill', slug: 'foo', version: null, path: '/x', enabled: null }] },
    });
    expect(browser.sent).toHaveLength(1);
    const m = JSON.parse(browser.sent[0]);
    expect(m.type).toBe('local.snapshot');
    expect(m.payload.daemonId).toBe('d-1');
    expect(getDaemonInventory('d-1')).toHaveLength(1);
  });

  it('applies delta and broadcasts local.delta', () => {
    const browser = new FakeSocket();
    gw.registerBrowser('s1', 'u1', browser as unknown as WebSocket);
    gw.subscribeBrowserToDaemon('s1', 'd-2');
    handleDaemonMessage(gw, 'd-2', {
      type: 'inventory.snapshot',
      id: 'i1',
      payload: { items: [] },
    });
    handleDaemonMessage(gw, 'd-2', {
      type: 'inventory.delta',
      id: 'i2',
      payload: {
        added: [{ type: 'skill', slug: 'bar', version: null, path: '/y', enabled: null }],
        removed: [],
        modified: [],
      },
    });
    expect(browser.sent).toHaveLength(2);
    const m2 = JSON.parse(browser.sent[1]);
    expect(m2.type).toBe('local.delta');
    expect(m2.payload.added).toHaveLength(1);
    expect(getDaemonInventory('d-2')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run src/ws/inventory.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';
import type { Gateway } from './gateway';
import type { InventoryItem, WssMessage } from '@hub/wss-protocol';

const daemonInventory = new Map<string, InventoryItem[]>();

export function getDaemonInventory(daemonId: string): InventoryItem[] {
  return daemonInventory.get(daemonId) ?? [];
}

export function clearDaemonInventory(daemonId: string): void {
  daemonInventory.delete(daemonId);
}

export function handleDaemonMessage(gw: Gateway, daemonId: string, msg: WssMessage): void {
  if (msg.type === 'inventory.snapshot') {
    daemonInventory.set(daemonId, msg.payload.items);
    gw.broadcastToSubscribers(daemonId, {
      type: 'local.snapshot',
      id: nanoid(),
      payload: { daemonId, items: msg.payload.items },
    });
  } else if (msg.type === 'inventory.delta') {
    const cur = daemonInventory.get(daemonId) ?? [];
    const removedKeys = new Set(msg.payload.removed.map((r) => `${r.type}:${r.slug}`));
    const filtered = cur.filter((i) => !removedKeys.has(`${i.type}:${i.slug}`));
    const modIndex = new Map(msg.payload.modified.map((m) => [`${m.type}:${m.slug}`, m]));
    const merged = filtered.map((i) => modIndex.get(`${i.type}:${i.slug}`) ?? i);
    const next = [...merged, ...msg.payload.added];
    daemonInventory.set(daemonId, next);
    gw.broadcastToSubscribers(daemonId, {
      type: 'local.delta',
      id: nanoid(),
      payload: { daemonId, ...msg.payload },
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run src/ws/inventory.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/ws/inventory.ts apps/hub-server/src/ws/inventory.test.ts
git commit -m "feat(server): broadcast inventory snapshots and deltas to dashboard subscribers"
```

---

### Task 18: Job request/response correlation (sendJob + resolveJob)

**Files:**
- Create: `apps/hub-server/src/ws/jobs.ts`
- Test: `apps/hub-server/src/ws/jobs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Gateway } from './gateway';
import { sendJob, resolveJob } from './jobs';

class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  send(d: string) { this.sent.push(d); }
}

describe('sendJob / resolveJob', () => {
  let gw: Gateway;
  let sock: FakeSocket;
  beforeEach(() => {
    gw = new Gateway();
    sock = new FakeSocket();
    gw.registerDaemon('d-1', sock as unknown as WebSocket);
  });

  it('sends a job and resolves on matching job.result', async () => {
    const p = sendJob(gw, 'd-1', 'job.install', { artifactVersionId: 'av-1', sha256: 'a'.repeat(64) });
    expect(sock.sent).toHaveLength(1);
    const sent = JSON.parse(sock.sent[0]);
    expect(sent.type).toBe('job.install');
    const requestId: string = sent.payload.requestId;
    resolveJob(requestId, { ok: true, data: { extracted: true } });
    await expect(p).resolves.toEqual({ ok: true, data: { extracted: true } });
  });

  it('rejects when daemon is offline', async () => {
    await expect(sendJob(gw, 'unknown', 'job.install', {})).rejects.toThrow(/daemon offline/);
  });

  it('rejects after timeout', async () => {
    vi.useFakeTimers();
    const p = sendJob(gw, 'd-1', 'job.install', {}, 1000);
    vi.advanceTimersByTime(1100);
    await expect(p).rejects.toThrow(/job timeout/);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run src/ws/jobs.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';
import type { Gateway } from './gateway';

type JobResult = { ok: boolean; error?: string; data?: Record<string, unknown> };

const pending = new Map<
  string,
  { resolve: (r: JobResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();

type SendableJobType = 'job.install' | 'job.package' | 'job.toggle' | 'job.uninstall';

export function sendJob(
  gw: Gateway,
  daemonId: string,
  type: SendableJobType,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<JobResult> {
  const sock = gw.getDaemonSocket(daemonId);
  if (!sock) return Promise.reject(new Error('daemon offline'));
  const requestId = nanoid();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('job timeout'));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    sock.send(JSON.stringify({ type, id: nanoid(), payload: { requestId, ...payload } }));
  });
}

export function resolveJob(requestId: string, result: JobResult): void {
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  p.resolve(result);
}

export function rejectAllJobsForDaemon(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run src/ws/jobs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/ws/jobs.ts apps/hub-server/src/ws/jobs.test.ts
git commit -m "feat(server): add WSS job request/response correlator with timeout"
```

---

## Sekce E — Daemon: skill manifest, scanner, watcher

### Task 19: Skill manifest parser (Go)

**Files:**
- Create: `apps/agent/internal/manifest/manifest.go`
- Create: `apps/agent/internal/manifest/skill.go`
- Test: `apps/agent/internal/manifest/skill_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package manifest

import (
    "os"
    "path/filepath"
    "testing"
)

func writeFile(t *testing.T, path, content string) {
    t.Helper()
    if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
        t.Fatal(err)
    }
    if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
        t.Fatal(err)
    }
}

func TestSkillParser_ValidFrontmatter(t *testing.T) {
    dir := t.TempDir()
    writeFile(t, filepath.Join(dir, "SKILL.md"),
        "---\nname: foo\ndescription: bar\n---\nbody\n")
    m, err := SkillParser{}.Parse(dir)
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if m.Name != "foo" || m.Type != "skill" || m.Description != "bar" || m.SchemaVersion != 1 {
        t.Fatalf("unexpected manifest: %+v", m)
    }
}

func TestSkillParser_FallsBackToBasenameMd(t *testing.T) {
    dir := t.TempDir()
    base := filepath.Base(dir)
    writeFile(t, filepath.Join(dir, base+".md"),
        "---\nname: alt\ndescription: alt-desc\n---\n")
    m, err := SkillParser{}.Parse(dir)
    if err != nil {
        t.Fatalf("err: %v", err)
    }
    if m.Name != "alt" {
        t.Fatalf("expected alt, got %s", m.Name)
    }
}

func TestSkillParser_MissingFile(t *testing.T) {
    dir := t.TempDir()
    if _, err := (SkillParser{}).Parse(dir); err == nil {
        t.Fatal("expected error")
    }
}

func TestSkillParser_MissingFrontmatter(t *testing.T) {
    dir := t.TempDir()
    writeFile(t, filepath.Join(dir, "SKILL.md"), "no frontmatter here")
    if _, err := (SkillParser{}).Parse(dir); err == nil {
        t.Fatal("expected error")
    }
}

func TestSkillParser_MissingName(t *testing.T) {
    dir := t.TempDir()
    writeFile(t, filepath.Join(dir, "SKILL.md"),
        "---\ndescription: only desc\n---\n")
    if _, err := (SkillParser{}).Parse(dir); err == nil {
        t.Fatal("expected error")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/manifest/...`
Expected: FAIL — package `manifest` does not declare `SkillParser`

- [ ] **Step 3: Write minimal implementation**

`apps/agent/internal/manifest/manifest.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package manifest

type ArtifactType string

const (
    TypeSkill   ArtifactType = "skill"
    TypePlugin  ArtifactType = "plugin"
    TypeCommand ArtifactType = "command"
    TypeAgent   ArtifactType = "agent"
)

type ArtifactManifest struct {
    SchemaVersion int                    `json:"schemaVersion"`
    Name          string                 `json:"name"`
    Type          ArtifactType           `json:"type"`
    Description   string                 `json:"description"`
    TypeMeta      map[string]interface{} `json:"typeMeta"`
}

type Parser interface {
    Type() ArtifactType
    Parse(rootDir string) (*ArtifactManifest, error)
}
```

`apps/agent/internal/manifest/skill.go`:
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

type SkillParser struct{}

func (SkillParser) Type() ArtifactType { return TypeSkill }

func (SkillParser) Parse(rootDir string) (*ArtifactManifest, error) {
    candidates := []string{
        filepath.Join(rootDir, "SKILL.md"),
        filepath.Join(rootDir, filepath.Base(rootDir)+".md"),
    }
    var data []byte
    var lastErr error
    for _, p := range candidates {
        b, err := os.ReadFile(p)
        if err == nil {
            data = b
            lastErr = nil
            break
        }
        lastErr = err
    }
    if data == nil {
        return nil, errors.New("no SKILL.md or <basename>.md found: " + lastErr.Error())
    }
    text := string(data)
    if !strings.HasPrefix(text, "---\n") {
        return nil, errors.New("missing frontmatter")
    }
    rest := text[4:]
    end := strings.Index(rest, "\n---")
    if end < 0 {
        return nil, errors.New("unterminated frontmatter")
    }
    fm := rest[:end]
    var raw struct {
        Name        string `yaml:"name"`
        Description string `yaml:"description"`
    }
    if err := yaml.Unmarshal([]byte(fm), &raw); err != nil {
        return nil, err
    }
    if raw.Name == "" {
        return nil, errors.New("name required")
    }
    return &ArtifactManifest{
        SchemaVersion: 1,
        Name:          raw.Name,
        Type:          TypeSkill,
        Description:   raw.Description,
        TypeMeta:      map[string]interface{}{},
    }, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/manifest/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/manifest/manifest.go apps/agent/internal/manifest/skill.go apps/agent/internal/manifest/skill_test.go
git commit -m "feat(agent): add skill manifest parser with YAML frontmatter"
```

---

### Task 20: Generic Scanner interface + SkillScanner

**Files:**
- Create: `apps/agent/internal/scanner/scanner.go`
- Create: `apps/agent/internal/scanner/skills.go`
- Test: `apps/agent/internal/scanner/skills_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
    "os"
    "path/filepath"
    "sort"
    "testing"

    "claude-hub/agent/internal/manifest"
)

func writeFile(t *testing.T, path, content string) {
    t.Helper()
    if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
        t.Fatal(err)
    }
    if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
        t.Fatal(err)
    }
}

func TestSkillScanner_ScansValidDirs(t *testing.T) {
    root := t.TempDir()
    writeFile(t, filepath.Join(root, "foo", "SKILL.md"),
        "---\nname: foo\ndescription: a\n---\n")
    writeFile(t, filepath.Join(root, "bar", "SKILL.md"),
        "---\nname: bar\ndescription: b\n---\n")
    if err := os.MkdirAll(filepath.Join(root, "broken"), 0o755); err != nil {
        t.Fatal(err)
    }

    items, err := SkillScanner{Root: root}.Scan()
    if err != nil {
        t.Fatalf("err: %v", err)
    }
    sort.Slice(items, func(i, j int) bool { return items[i].Slug < items[j].Slug })
    if len(items) != 2 {
        t.Fatalf("expected 2 items, got %d", len(items))
    }
    if items[0].Slug != "bar" || items[1].Slug != "foo" {
        t.Fatalf("unexpected slugs: %+v", items)
    }
    if items[0].Type != manifest.TypeSkill {
        t.Fatalf("expected skill type")
    }
}

func TestSkillScanner_MissingRootReturnsEmpty(t *testing.T) {
    items, err := SkillScanner{Root: "/nonexistent/path/that/does/not/exist"}.Scan()
    if err != nil {
        t.Fatalf("expected no error, got %v", err)
    }
    if len(items) != 0 {
        t.Fatalf("expected empty, got %d", len(items))
    }
}

func TestSkillScanner_SkipsBackupDir(t *testing.T) {
    root := t.TempDir()
    writeFile(t, filepath.Join(root, ".claude-hub-backup", "old", "SKILL.md"),
        "---\nname: old\ndescription: x\n---\n")
    items, err := SkillScanner{Root: root}.Scan()
    if err != nil {
        t.Fatal(err)
    }
    if len(items) != 0 {
        t.Fatalf("expected backup dir to be skipped, got %d", len(items))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/scanner/...`
Expected: FAIL — package `scanner` does not declare `SkillScanner`

- [ ] **Step 3: Write minimal implementation**

`apps/agent/internal/scanner/scanner.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
    "claude-hub/agent/internal/api"
    "claude-hub/agent/internal/manifest"
)

type Scanner interface {
    Type() manifest.ArtifactType
    Scan() ([]api.InventoryItem, error)
}

type Registry struct {
    scanners []Scanner
}

func NewRegistry(scs ...Scanner) *Registry {
    return &Registry{scanners: scs}
}

func (r *Registry) ScanAll() ([]api.InventoryItem, error) {
    out := []api.InventoryItem{}
    for _, s := range r.scanners {
        items, err := s.Scan()
        if err != nil {
            return nil, err
        }
        out = append(out, items...)
    }
    return out, nil
}
```

`apps/agent/internal/scanner/skills.go`:
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

type SkillScanner struct {
    Root string
}

func (s SkillScanner) Type() manifest.ArtifactType { return manifest.TypeSkill }

func (s SkillScanner) Scan() ([]api.InventoryItem, error) {
    entries, err := os.ReadDir(s.Root)
    if err != nil {
        if os.IsNotExist(err) {
            return []api.InventoryItem{}, nil
        }
        return nil, err
    }
    parser := manifest.SkillParser{}
    out := make([]api.InventoryItem, 0, len(entries))
    for _, e := range entries {
        if !e.IsDir() {
            continue
        }
        if e.Name() == ".claude-hub-backup" {
            continue
        }
        full := filepath.Join(s.Root, e.Name())
        m, err := parser.Parse(full)
        if err != nil {
            slog.Warn("skipping skill dir", "dir", full, "err", err)
            continue
        }
        out = append(out, api.InventoryItem{
            Type:    manifest.TypeSkill,
            Slug:    m.Name,
            Path:    full,
            Enabled: nil,
        })
    }
    return out, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/scanner/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/scanner/scanner.go apps/agent/internal/scanner/skills.go apps/agent/internal/scanner/skills_test.go
git commit -m "feat(agent): add Scanner interface and SkillScanner"
```

---

### Task 21: fsnotify watcher with debounce

**Files:**
- Create: `apps/agent/internal/scanner/watcher.go`
- Test: `apps/agent/internal/scanner/watcher_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
    "context"
    "os"
    "path/filepath"
    "sync/atomic"
    "testing"
    "time"
)

func TestWatcher_DebouncesRapidChanges(t *testing.T) {
    root := t.TempDir()
    var calls int32
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    w := NewWatcher(root, 200*time.Millisecond, func() {
        atomic.AddInt32(&calls, 1)
    })
    errCh := make(chan error, 1)
    go func() { errCh <- w.Run(ctx) }()
    time.Sleep(50 * time.Millisecond)

    for i := 0; i < 5; i++ {
        if err := os.WriteFile(filepath.Join(root, "x.txt"), []byte{byte(i)}, 0o644); err != nil {
            t.Fatal(err)
        }
        time.Sleep(20 * time.Millisecond)
    }
    time.Sleep(400 * time.Millisecond)

    if got := atomic.LoadInt32(&calls); got != 1 {
        t.Fatalf("expected exactly 1 debounced call, got %d", got)
    }
    cancel()
    <-errCh
}

func TestWatcher_StopsCleanly(t *testing.T) {
    root := t.TempDir()
    ctx, cancel := context.WithCancel(context.Background())
    w := NewWatcher(root, 100*time.Millisecond, func() {})
    done := make(chan error, 1)
    go func() { done <- w.Run(ctx) }()
    cancel()
    select {
    case <-done:
    case <-time.After(2 * time.Second):
        t.Fatal("watcher did not stop")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/scanner/...`
Expected: FAIL — `NewWatcher` undefined

- [ ] **Step 3: Write minimal implementation**

```go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
    "context"
    "os"
    "time"

    "github.com/fsnotify/fsnotify"
)

type Watcher struct {
    root      string
    debounce  time.Duration
    onChange  func()
}

func NewWatcher(root string, debounce time.Duration, onChange func()) *Watcher {
    return &Watcher{root: root, debounce: debounce, onChange: onChange}
}

func (w *Watcher) Run(ctx context.Context) error {
    fw, err := fsnotify.NewWatcher()
    if err != nil {
        return err
    }
    defer fw.Close()
    if err := fw.Add(w.root); err != nil && !os.IsNotExist(err) {
        return err
    }

    var timer *time.Timer
    fire := func() {
        if timer != nil {
            timer.Stop()
        }
        timer = time.AfterFunc(w.debounce, w.onChange)
    }

    for {
        select {
        case <-ctx.Done():
            if timer != nil {
                timer.Stop()
            }
            return nil
        case _, ok := <-fw.Events:
            if !ok {
                return nil
            }
            fire()
        case _, ok := <-fw.Errors:
            if !ok {
                return nil
            }
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/scanner/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/scanner/watcher.go apps/agent/internal/scanner/watcher_test.go
git commit -m "feat(agent): add debounced fsnotify watcher"
```

---

### Task 22: Wire scanner -> WSS inventory.snapshot + delta

**Files:**
- Create: `apps/agent/internal/wss/inventory.go`
- Test: `apps/agent/internal/wss/inventory_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package wss

import (
    "encoding/json"
    "testing"

    "claude-hub/agent/internal/api"
    "claude-hub/agent/internal/manifest"
)

func TestDiffInventory_AddedRemovedModified(t *testing.T) {
    prev := []api.InventoryItem{
        {Type: manifest.TypeSkill, Slug: "kept", Path: "/a"},
        {Type: manifest.TypeSkill, Slug: "removed", Path: "/b"},
        {Type: manifest.TypeSkill, Slug: "modified", Path: "/c", Version: "0.1.0"},
    }
    cur := []api.InventoryItem{
        {Type: manifest.TypeSkill, Slug: "kept", Path: "/a"},
        {Type: manifest.TypeSkill, Slug: "added", Path: "/d"},
        {Type: manifest.TypeSkill, Slug: "modified", Path: "/c", Version: "0.2.0"},
    }
    diff := DiffInventory(prev, cur)
    if len(diff.Added) != 1 || diff.Added[0].Slug != "added" {
        t.Fatalf("added wrong: %+v", diff.Added)
    }
    if len(diff.Removed) != 1 || diff.Removed[0].Slug != "removed" {
        t.Fatalf("removed wrong: %+v", diff.Removed)
    }
    if len(diff.Modified) != 1 || diff.Modified[0].Slug != "modified" {
        t.Fatalf("modified wrong: %+v", diff.Modified)
    }
}

func TestSnapshotPayload_Serializes(t *testing.T) {
    items := []api.InventoryItem{{Type: manifest.TypeSkill, Slug: "foo", Path: "/x"}}
    payload := SnapshotPayload(items)
    b, err := json.Marshal(payload)
    if err != nil {
        t.Fatal(err)
    }
    if string(b) == "" {
        t.Fatal("empty payload")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/wss/...`
Expected: FAIL — DiffInventory / SnapshotPayload undefined

- [ ] **Step 3: Write minimal implementation**

```go
// SPDX-License-Identifier: Apache-2.0
package wss

import "claude-hub/agent/internal/api"

type InventoryDelta struct {
    Added    []api.InventoryItem `json:"added"`
    Removed  []RemovedRef        `json:"removed"`
    Modified []api.InventoryItem `json:"modified"`
}

type RemovedRef struct {
    Type string `json:"type"`
    Slug string `json:"slug"`
}

func key(i api.InventoryItem) string { return string(i.Type) + ":" + i.Slug }

func DiffInventory(prev, cur []api.InventoryItem) InventoryDelta {
    prevIdx := make(map[string]api.InventoryItem, len(prev))
    for _, p := range prev {
        prevIdx[key(p)] = p
    }
    curIdx := make(map[string]api.InventoryItem, len(cur))
    for _, c := range cur {
        curIdx[key(c)] = c
    }

    var added, modified []api.InventoryItem
    var removed []RemovedRef
    for k, c := range curIdx {
        p, ok := prevIdx[k]
        if !ok {
            added = append(added, c)
            continue
        }
        if p.Version != c.Version || !equalEnabled(p.Enabled, c.Enabled) {
            modified = append(modified, c)
        }
    }
    for k, p := range prevIdx {
        if _, ok := curIdx[k]; !ok {
            removed = append(removed, RemovedRef{Type: string(p.Type), Slug: p.Slug})
        }
    }
    return InventoryDelta{
        Added:    nilToEmpty(added),
        Removed:  nilRefsToEmpty(removed),
        Modified: nilToEmpty(modified),
    }
}

func equalEnabled(a, b *bool) bool {
    if a == nil && b == nil {
        return true
    }
    if a == nil || b == nil {
        return false
    }
    return *a == *b
}

func nilToEmpty(s []api.InventoryItem) []api.InventoryItem {
    if s == nil {
        return []api.InventoryItem{}
    }
    return s
}

func nilRefsToEmpty(s []RemovedRef) []RemovedRef {
    if s == nil {
        return []RemovedRef{}
    }
    return s
}

func SnapshotPayload(items []api.InventoryItem) map[string]any {
    return map[string]any{"items": items}
}

func DeltaPayload(d InventoryDelta) map[string]any {
    return map[string]any{
        "added":    d.Added,
        "removed":  d.Removed,
        "modified": d.Modified,
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/wss/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/wss/inventory.go apps/agent/internal/wss/inventory_test.go
git commit -m "feat(agent): compute inventory diff for snapshot/delta WSS messages"
```

---

## Sekce F — Daemon: package + install jobs

### Task 23: tar.gz packager with sha256

**Files:**
- Create: `apps/agent/internal/jobs/jobs.go`
- Create: `apps/agent/internal/jobs/package.go`
- Test: `apps/agent/internal/jobs/package_test.go`

- [ ] **Step 1: Write the failing test**

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
    "testing"
)

func writeFile(t *testing.T, path, content string) {
    t.Helper()
    if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
        t.Fatal(err)
    }
    if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
        t.Fatal(err)
    }
}

func TestPackageDir_RoundTrip(t *testing.T) {
    src := t.TempDir()
    writeFile(t, filepath.Join(src, "SKILL.md"), "---\nname: x\n---\n")
    writeFile(t, filepath.Join(src, "sub", "a.txt"), "hello")

    dest := filepath.Join(t.TempDir(), "out.tar.gz")
    sha, err := PackageDir(src, dest)
    if err != nil {
        t.Fatalf("PackageDir: %v", err)
    }
    if len(sha) != 64 {
        t.Fatalf("sha256 length: %d", len(sha))
    }

    // Verify sha matches actual bytes
    f, err := os.Open(dest)
    if err != nil {
        t.Fatal(err)
    }
    defer f.Close()
    h := sha256.New()
    if _, err := io.Copy(h, f); err != nil {
        t.Fatal(err)
    }
    if hex.EncodeToString(h.Sum(nil)) != sha {
        t.Fatalf("sha mismatch")
    }

    // Extract and compare
    f.Seek(0, 0)
    gz, err := gzip.NewReader(f)
    if err != nil {
        t.Fatal(err)
    }
    tr := tar.NewReader(gz)
    seen := map[string]string{}
    for {
        hdr, err := tr.Next()
        if err == io.EOF {
            break
        }
        if err != nil {
            t.Fatal(err)
        }
        if hdr.Typeflag == tar.TypeReg {
            b, _ := io.ReadAll(tr)
            seen[hdr.Name] = string(b)
        }
    }
    if seen["SKILL.md"] == "" || seen["sub/a.txt"] != "hello" {
        t.Fatalf("missing files: %+v", seen)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/jobs/...`
Expected: FAIL — `PackageDir` undefined

- [ ] **Step 3: Write minimal implementation**

`apps/agent/internal/jobs/jobs.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package jobs

import (
    "net/http"

    "claude-hub/agent/internal/manifest"
)

type Jobs struct {
    HubURL      string
    DeviceToken string
    HTTPClient  *http.Client
    Parsers     map[manifest.ArtifactType]manifest.Parser
    SkillsRoot  string
}

func New(hubURL, deviceToken, skillsRoot string) *Jobs {
    return &Jobs{
        HubURL:      hubURL,
        DeviceToken: deviceToken,
        HTTPClient:  &http.Client{},
        SkillsRoot:  skillsRoot,
        Parsers: map[manifest.ArtifactType]manifest.Parser{
            manifest.TypeSkill: manifest.SkillParser{},
        },
    }
}
```

`apps/agent/internal/jobs/package.go`:
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
    if err != nil {
        return "", err
    }
    defer f.Close()

    h := sha256.New()
    mw := io.MultiWriter(f, h)
    gz := gzip.NewWriter(mw)
    tw := tar.NewWriter(gz)

    walkErr := filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        rel, err := filepath.Rel(src, p)
        if err != nil {
            return err
        }
        if rel == "." {
            return nil
        }
        hdr, err := tar.FileInfoHeader(info, "")
        if err != nil {
            return err
        }
        hdr.Name = filepath.ToSlash(rel)
        if err := tw.WriteHeader(hdr); err != nil {
            return err
        }
        if !info.Mode().IsRegular() {
            return nil
        }
        rf, err := os.Open(p)
        if err != nil {
            return err
        }
        defer rf.Close()
        _, err = io.Copy(tw, rf)
        return err
    })
    if walkErr != nil {
        return "", walkErr
    }
    if err := tw.Close(); err != nil {
        return "", err
    }
    if err := gz.Close(); err != nil {
        return "", err
    }
    return hex.EncodeToString(h.Sum(nil)), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/jobs/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/jobs/jobs.go apps/agent/internal/jobs/package.go apps/agent/internal/jobs/package_test.go
git commit -m "feat(agent): add tar.gz packager with sha256"
```

---

### Task 24: Publish job — package + REST upload

**Files:**
- Create: `apps/agent/internal/jobs/publish.go`
- Test: `apps/agent/internal/jobs/publish_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package jobs

import (
    "encoding/json"
    "io"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "strings"
    "testing"

    "claude-hub/agent/internal/manifest"
)

func TestPublish_SendsExpectedMultipart(t *testing.T) {
    src := t.TempDir()
    if err := os.WriteFile(filepath.Join(src, "SKILL.md"),
        []byte("---\nname: foo\ndescription: d\n---\n"), 0o644); err != nil {
        t.Fatal(err)
    }

    var gotForm map[string]string
    var gotFile []byte
    mux := http.NewServeMux()
    mux.HandleFunc("/api/artifacts/upload", func(w http.ResponseWriter, r *http.Request) {
        if got := r.Header.Get("Authorization"); got != "Bearer dev-tok" {
            t.Errorf("auth: %s", got)
        }
        if err := r.ParseMultipartForm(32 << 20); err != nil {
            t.Fatal(err)
        }
        gotForm = map[string]string{}
        for k := range r.MultipartForm.Value {
            gotForm[k] = r.FormValue(k)
        }
        f, _, err := r.FormFile("file")
        if err != nil {
            t.Fatal(err)
        }
        gotFile, _ = io.ReadAll(f)
        w.WriteHeader(201)
        _, _ = w.Write([]byte(`{"artifactId":"a-1","versionId":"v-1"}`))
    })
    srv := httptest.NewServer(mux)
    defer srv.Close()

    j := &Jobs{
        HubURL:      srv.URL,
        DeviceToken: "dev-tok",
        HTTPClient:  srv.Client(),
        Parsers:     map[manifest.ArtifactType]manifest.Parser{manifest.TypeSkill: manifest.SkillParser{}},
    }
    res, err := j.Publish(PublishRequest{
        Slug: "foo", Type: "skill", Version: "0.1.0",
        Description: "d", SourcePath: src,
    })
    if err != nil {
        t.Fatalf("publish err: %v", err)
    }
    if res.ArtifactID != "a-1" || res.VersionID != "v-1" {
        t.Fatalf("unexpected result: %+v", res)
    }
    if gotForm["slug"] != "foo" || gotForm["type"] != "skill" || gotForm["version"] != "0.1.0" {
        t.Fatalf("form: %+v", gotForm)
    }
    if !strings.HasPrefix(gotForm["sha256"], "") || len(gotForm["sha256"]) != 64 {
        t.Fatalf("sha length: %d", len(gotForm["sha256"]))
    }
    if len(gotFile) == 0 {
        t.Fatal("empty file")
    }
    var m struct{ Name, Type, Description string }
    if err := json.Unmarshal([]byte(gotForm["manifest"]), &m); err != nil {
        t.Fatalf("manifest json: %v", err)
    }
    if m.Name != "foo" || m.Type != "skill" {
        t.Fatalf("manifest: %+v", m)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/jobs/...`
Expected: FAIL — Publish method missing

- [ ] **Step 3: Write minimal implementation**

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

    "claude-hub/agent/internal/manifest"
)

type PublishRequest struct {
    Slug        string
    Type        string
    Version     string
    Description string
    SourcePath  string
}

type PublishResult struct {
    ArtifactID string `json:"artifactId"`
    VersionID  string `json:"versionId"`
}

func (j *Jobs) Publish(req PublishRequest) (*PublishResult, error) {
    parser, ok := j.Parsers[manifest.ArtifactType(req.Type)]
    if !ok {
        return nil, fmt.Errorf("no parser for type %s", req.Type)
    }
    m, err := parser.Parse(req.SourcePath)
    if err != nil {
        return nil, fmt.Errorf("parse manifest: %w", err)
    }
    if req.Description != "" {
        m.Description = req.Description
    }

    tmp := filepath.Join(os.TempDir(), fmt.Sprintf("hub-pub-%s-%s.tar.gz", req.Slug, req.Version))
    defer os.Remove(tmp)
    sha, err := PackageDir(req.SourcePath, tmp)
    if err != nil {
        return nil, fmt.Errorf("package: %w", err)
    }

    body := &bytes.Buffer{}
    w := multipart.NewWriter(body)
    if err := w.WriteField("slug", req.Slug); err != nil {
        return nil, err
    }
    if err := w.WriteField("type", req.Type); err != nil {
        return nil, err
    }
    if err := w.WriteField("version", req.Version); err != nil {
        return nil, err
    }
    if err := w.WriteField("description", req.Description); err != nil {
        return nil, err
    }
    if err := w.WriteField("sha256", sha); err != nil {
        return nil, err
    }
    mj, err := json.Marshal(m)
    if err != nil {
        return nil, err
    }
    if err := w.WriteField("manifest", string(mj)); err != nil {
        return nil, err
    }
    fw, err := w.CreateFormFile("file", filepath.Base(tmp))
    if err != nil {
        return nil, err
    }
    f, err := os.Open(tmp)
    if err != nil {
        return nil, err
    }
    if _, err := io.Copy(fw, f); err != nil {
        f.Close()
        return nil, err
    }
    f.Close()
    if err := w.Close(); err != nil {
        return nil, err
    }

    httpReq, err := http.NewRequest("POST", j.HubURL+"/api/artifacts/upload", body)
    if err != nil {
        return nil, err
    }
    httpReq.Header.Set("Content-Type", w.FormDataContentType())
    httpReq.Header.Set("Authorization", "Bearer "+j.DeviceToken)
    resp, err := j.HTTPClient.Do(httpReq)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    if resp.StatusCode >= 400 {
        b, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("upload failed: %d %s", resp.StatusCode, string(b))
    }
    var out PublishResult
    if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
        return nil, err
    }
    return &out, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/jobs/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/jobs/publish.go apps/agent/internal/jobs/publish_test.go
git commit -m "feat(agent): add publish job (package + REST upload)"
```

---

### Task 25: Install job — download, verify, extract with backup + path-traversal guard

**Files:**
- Create: `apps/agent/internal/jobs/install.go`
- Test: `apps/agent/internal/jobs/install_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package jobs

import (
    "archive/tar"
    "bytes"
    "compress/gzip"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func makeTarGz(files map[string]string) ([]byte, string) {
    buf := &bytes.Buffer{}
    h := sha256.New()
    gz := gzip.NewWriter(buf)
    tw := tar.NewWriter(gz)
    for name, content := range files {
        hdr := &tar.Header{
            Name:     name,
            Mode:     0o644,
            Size:     int64(len(content)),
            Typeflag: tar.TypeReg,
        }
        _ = tw.WriteHeader(hdr)
        _, _ = tw.Write([]byte(content))
    }
    _ = tw.Close()
    _ = gz.Close()
    h.Write(buf.Bytes())
    return buf.Bytes(), hex.EncodeToString(h.Sum(nil))
}

func TestInstall_HappyPath(t *testing.T) {
    bytesGz, sha := makeTarGz(map[string]string{
        "SKILL.md":  "---\nname: foo\n---\n",
        "sub/a.txt": "hello",
    })
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _, _ = w.Write(bytesGz)
    }))
    defer srv.Close()

    home := t.TempDir()
    skillsRoot := filepath.Join(home, ".claude", "skills")
    if err := os.MkdirAll(skillsRoot, 0o755); err != nil {
        t.Fatal(err)
    }
    target := filepath.Join(skillsRoot, "foo")

    j := &Jobs{HTTPClient: srv.Client(), SkillsRoot: skillsRoot}
    if err := j.Install(InstallRequest{
        DownloadURL: srv.URL,
        Sha256:      sha,
        TargetPath:  target,
    }); err != nil {
        t.Fatalf("install: %v", err)
    }
    if _, err := os.Stat(filepath.Join(target, "SKILL.md")); err != nil {
        t.Fatalf("expected SKILL.md: %v", err)
    }
    if b, err := os.ReadFile(filepath.Join(target, "sub", "a.txt")); err != nil || string(b) != "hello" {
        t.Fatalf("sub file wrong: %v %s", err, b)
    }
}

func TestInstall_BackupOnReinstall(t *testing.T) {
    bytesGz, sha := makeTarGz(map[string]string{"SKILL.md": "---\nname: foo\n---\nv2"})
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _, _ = w.Write(bytesGz)
    }))
    defer srv.Close()

    skillsRoot := t.TempDir()
    target := filepath.Join(skillsRoot, "foo")
    _ = os.MkdirAll(target, 0o755)
    _ = os.WriteFile(filepath.Join(target, "OLD.md"), []byte("v1"), 0o644)

    j := &Jobs{HTTPClient: srv.Client(), SkillsRoot: skillsRoot}
    if err := j.Install(InstallRequest{
        DownloadURL: srv.URL, Sha256: sha, TargetPath: target,
    }); err != nil {
        t.Fatalf("install: %v", err)
    }
    backupRoot := filepath.Join(skillsRoot, ".claude-hub-backup")
    entries, err := os.ReadDir(backupRoot)
    if err != nil {
        t.Fatalf("backup root missing: %v", err)
    }
    if len(entries) != 1 {
        t.Fatalf("expected 1 backup, got %d", len(entries))
    }
    if _, err := os.Stat(filepath.Join(backupRoot, entries[0].Name(), "OLD.md")); err != nil {
        t.Fatalf("expected OLD.md in backup: %v", err)
    }
}

func TestInstall_Sha256Mismatch(t *testing.T) {
    bytesGz, _ := makeTarGz(map[string]string{"SKILL.md": "---\nname: foo\n---\n"})
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _, _ = w.Write(bytesGz)
    }))
    defer srv.Close()

    skillsRoot := t.TempDir()
    target := filepath.Join(skillsRoot, "foo")
    j := &Jobs{HTTPClient: srv.Client(), SkillsRoot: skillsRoot}
    err := j.Install(InstallRequest{DownloadURL: srv.URL, Sha256: "a" + string(make([]byte, 63)), TargetPath: target})
    if err == nil {
        t.Fatal("expected sha mismatch error")
    }
    if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
        t.Fatalf("target should not exist on mismatch")
    }
}

func TestInstall_RejectsPathTraversal(t *testing.T) {
    var buf bytes.Buffer
    h := sha256.New()
    gz := gzip.NewWriter(&buf)
    tw := tar.NewWriter(gz)
    payload := "pwned"
    _ = tw.WriteHeader(&tar.Header{Name: "../../../etc/passwd", Mode: 0o644, Size: int64(len(payload)), Typeflag: tar.TypeReg})
    _, _ = tw.Write([]byte(payload))
    _ = tw.Close()
    _ = gz.Close()
    h.Write(buf.Bytes())
    sha := hex.EncodeToString(h.Sum(nil))

    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _, _ = w.Write(buf.Bytes())
    }))
    defer srv.Close()

    skillsRoot := t.TempDir()
    target := filepath.Join(skillsRoot, "foo")
    j := &Jobs{HTTPClient: srv.Client(), SkillsRoot: skillsRoot}
    err := j.Install(InstallRequest{DownloadURL: srv.URL, Sha256: sha, TargetPath: target})
    if err == nil {
        t.Fatal("expected path-traversal rejection")
    }
}

func TestInstall_RejectsTargetOutsideSkillsRoot(t *testing.T) {
    skillsRoot := t.TempDir()
    j := &Jobs{HTTPClient: http.DefaultClient, SkillsRoot: skillsRoot}
    err := j.Install(InstallRequest{
        DownloadURL: "http://x", Sha256: "x",
        TargetPath: filepath.Join(t.TempDir(), "elsewhere"),
    })
    if err == nil || err.Error() == "" {
        t.Fatal("expected error for outside skills root")
    }
    if !contains(err.Error(), "outside skills root") {
        t.Fatalf("unexpected err: %v", err)
    }
}

func contains(s, sub string) bool {
    return len(s) >= len(sub) && (s == sub || (len(s) > 0 && (containsHelper(s, sub))))
}

func containsHelper(s, sub string) bool {
    for i := 0; i+len(sub) <= len(s); i++ {
        if s[i:i+len(sub)] == sub {
            return true
        }
    }
    return false
}

var _ = fmt.Sprintf
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/jobs/...`
Expected: FAIL — Install method missing

- [ ] **Step 3: Write minimal implementation**

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
    TargetPath  string
}

func (j *Jobs) Install(req InstallRequest) error {
    abs, err := filepath.Abs(req.TargetPath)
    if err != nil {
        return err
    }
    rootAbs, err := filepath.Abs(j.SkillsRoot)
    if err != nil {
        return err
    }
    if !strings.HasPrefix(abs+string(os.PathSeparator), rootAbs+string(os.PathSeparator)) {
        return fmt.Errorf("target outside skills root")
    }

    httpReq, err := http.NewRequest("GET", req.DownloadURL, nil)
    if err != nil {
        return err
    }
    resp, err := j.HTTPClient.Do(httpReq)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    if resp.StatusCode != 200 {
        return fmt.Errorf("download status %d", resp.StatusCode)
    }

    tmp, err := os.CreateTemp("", "hub-install-*.tar.gz")
    if err != nil {
        return err
    }
    defer os.Remove(tmp.Name())
    h := sha256.New()
    if _, err := io.Copy(io.MultiWriter(tmp, h), resp.Body); err != nil {
        return err
    }
    if hex.EncodeToString(h.Sum(nil)) != req.Sha256 {
        return fmt.Errorf("sha256 mismatch")
    }
    if _, err := tmp.Seek(0, 0); err != nil {
        return err
    }

    if _, err := os.Stat(abs); err == nil {
        backupRoot := filepath.Join(rootAbs, ".claude-hub-backup")
        if err := os.MkdirAll(backupRoot, 0o755); err != nil {
            return err
        }
        backupDir := filepath.Join(backupRoot, fmt.Sprintf("%s-%d", filepath.Base(abs), time.Now().Unix()))
        if err := os.Rename(abs, backupDir); err != nil {
            return err
        }
    }
    if err := os.MkdirAll(abs, 0o755); err != nil {
        return err
    }

    gz, err := gzip.NewReader(tmp)
    if err != nil {
        return err
    }
    defer gz.Close()
    tr := tar.NewReader(gz)
    for {
        hdr, err := tr.Next()
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }
        clean := filepath.Clean(hdr.Name)
        if strings.HasPrefix(clean, "..") || strings.Contains(clean, ".."+string(os.PathSeparator)) || filepath.IsAbs(clean) {
            return fmt.Errorf("unsafe path in archive: %s", hdr.Name)
        }
        out := filepath.Join(abs, filepath.FromSlash(clean))
        outAbs, err := filepath.Abs(out)
        if err != nil {
            return err
        }
        if !strings.HasPrefix(outAbs+string(os.PathSeparator), abs+string(os.PathSeparator)) && outAbs != abs {
            return fmt.Errorf("escape attempt: %s", hdr.Name)
        }
        switch hdr.Typeflag {
        case tar.TypeDir:
            if err := os.MkdirAll(out, os.FileMode(hdr.Mode)); err != nil {
                return err
            }
        case tar.TypeReg:
            if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
                return err
            }
            f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode))
            if err != nil {
                return err
            }
            if _, err := io.Copy(f, tr); err != nil {
                f.Close()
                return err
            }
            f.Close()
        }
    }
    return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/jobs/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/jobs/install.go apps/agent/internal/jobs/install_test.go
git commit -m "feat(agent): add install job with backup and path-traversal guard"
```

---

### Task 26: WSS router handles job.install + job.package + ping

**Files:**
- Create: `apps/agent/internal/wss/router.go`
- Test: `apps/agent/internal/wss/router_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package wss

import (
    "encoding/json"
    "errors"
    "testing"
)

type fakeSender struct{ sent []map[string]any }

func (f *fakeSender) Send(msgType string, payload map[string]any) error {
    f.sent = append(f.sent, map[string]any{"type": msgType, "payload": payload})
    return nil
}

type fakeJobs struct {
    installErr error
    pubResult  map[string]any
    pubErr     error
}

func (j *fakeJobs) RunInstall(payload map[string]any) error          { return j.installErr }
func (j *fakeJobs) RunPackage(payload map[string]any) (map[string]any, error) {
    return j.pubResult, j.pubErr
}

func TestRouter_PingResponds(t *testing.T) {
    snd := &fakeSender{}
    r := NewRouter(snd, &fakeJobs{})
    r.Handle([]byte(`{"type":"ping","id":"1","payload":{}}`))
    if len(snd.sent) != 1 || snd.sent[0]["type"] != "pong" {
        t.Fatalf("expected pong, got %+v", snd.sent)
    }
}

func TestRouter_JobInstallSuccess(t *testing.T) {
    snd := &fakeSender{}
    r := NewRouter(snd, &fakeJobs{})
    r.Handle([]byte(`{"type":"job.install","id":"1","payload":{"requestId":"rq","sha256":"a"}}`))
    r.Wait()
    if len(snd.sent) != 1 {
        t.Fatalf("expected 1 message, got %d", len(snd.sent))
    }
    msg := snd.sent[0]
    if msg["type"] != "job.result" {
        t.Fatalf("type: %v", msg["type"])
    }
    p := msg["payload"].(map[string]any)
    if p["ok"] != true || p["requestId"] != "rq" {
        t.Fatalf("payload: %+v", p)
    }
}

func TestRouter_JobInstallFailure(t *testing.T) {
    snd := &fakeSender{}
    r := NewRouter(snd, &fakeJobs{installErr: errors.New("boom")})
    r.Handle([]byte(`{"type":"job.install","id":"1","payload":{"requestId":"rq"}}`))
    r.Wait()
    p := snd.sent[0]["payload"].(map[string]any)
    if p["ok"] != false || p["error"] != "boom" {
        t.Fatalf("expected failure, got %+v", p)
    }
}

func TestRouter_JobPackage(t *testing.T) {
    snd := &fakeSender{}
    r := NewRouter(snd, &fakeJobs{pubResult: map[string]any{"artifactId": "a", "versionId": "v"}})
    r.Handle([]byte(`{"type":"job.package","id":"1","payload":{"requestId":"rq"}}`))
    r.Wait()
    p := snd.sent[0]["payload"].(map[string]any)
    if p["ok"] != true {
        t.Fatalf("expected ok, got %+v", p)
    }
    data := p["data"].(map[string]any)
    if data["artifactId"] != "a" {
        t.Fatalf("data: %+v", data)
    }
}

var _ = json.Marshal
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/wss/...`
Expected: FAIL — `NewRouter` undefined

- [ ] **Step 3: Write minimal implementation**

```go
// SPDX-License-Identifier: Apache-2.0
package wss

import (
    "encoding/json"
    "log/slog"
    "sync"
)

type Sender interface {
    Send(msgType string, payload map[string]any) error
}

type JobRunner interface {
    RunInstall(payload map[string]any) error
    RunPackage(payload map[string]any) (map[string]any, error)
}

type Router struct {
    sender Sender
    jobs   JobRunner
    wg     sync.WaitGroup
    queue  chan func()
    once   sync.Once
}

func NewRouter(sender Sender, jobs JobRunner) *Router {
    r := &Router{sender: sender, jobs: jobs, queue: make(chan func(), 16)}
    r.once.Do(func() {
        go r.consume()
    })
    return r
}

func (r *Router) consume() {
    for fn := range r.queue {
        fn()
        r.wg.Done()
    }
}

func (r *Router) Wait() {
    r.wg.Wait()
}

type rawMessage struct {
    Type    string          `json:"type"`
    ID      string          `json:"id"`
    Payload json.RawMessage `json:"payload"`
}

func (r *Router) Handle(raw []byte) {
    var msg rawMessage
    if err := json.Unmarshal(raw, &msg); err != nil {
        slog.Warn("malformed wss message", "err", err)
        return
    }
    var payload map[string]any
    if len(msg.Payload) > 0 {
        _ = json.Unmarshal(msg.Payload, &payload)
    }

    switch msg.Type {
    case "ping":
        _ = r.sender.Send("pong", map[string]any{})
    case "job.install":
        r.wg.Add(1)
        r.queue <- func() {
            requestID, _ := payload["requestId"].(string)
            err := r.jobs.RunInstall(payload)
            r.emitResult(requestID, err, nil)
        }
    case "job.package":
        r.wg.Add(1)
        r.queue <- func() {
            requestID, _ := payload["requestId"].(string)
            data, err := r.jobs.RunPackage(payload)
            r.emitResult(requestID, err, data)
        }
    default:
        slog.Debug("unhandled message type", "type", msg.Type)
    }
}

func (r *Router) emitResult(requestID string, err error, data map[string]any) {
    if err != nil {
        _ = r.sender.Send("job.result", map[string]any{
            "requestId": requestID,
            "ok":        false,
            "error":     err.Error(),
        })
        return
    }
    out := map[string]any{
        "requestId": requestID,
        "ok":        true,
    }
    if data != nil {
        out["data"] = data
    }
    _ = r.sender.Send("job.result", out)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/wss/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/wss/router.go apps/agent/internal/wss/router_test.go
git commit -m "feat(agent): handle install and package jobs in WSS router"
```

---

## Sekce G — Daemon local HTTP API

### Task 27: POST /v1/publish local endpoint

**Files:**
- Create: `apps/agent/internal/api/local/publish.go`
- Test: `apps/agent/internal/api/local/publish_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "claude-hub/agent/internal/jobs"
)

type stubPub struct{ called bool }

func (s *stubPub) Publish(req jobs.PublishRequest) (*jobs.PublishResult, error) {
    s.called = true
    return &jobs.PublishResult{ArtifactID: "a-1", VersionID: "v-1"}, nil
}

func TestPublish_Authorized(t *testing.T) {
    p := &stubPub{}
    h := PublishHandler(p, "tok-abc")
    body, _ := json.Marshal(map[string]string{
        "slug": "foo", "type": "skill", "version": "0.1.0",
        "description": "d", "source_path": "/x",
    })
    req := httptest.NewRequest("POST", "/v1/publish", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok-abc")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != 200 {
        t.Fatalf("status %d body %s", w.Code, w.Body.String())
    }
    var got map[string]string
    _ = json.Unmarshal(w.Body.Bytes(), &got)
    if got["artifactId"] != "a-1" {
        t.Fatalf("body: %+v", got)
    }
    if !p.called {
        t.Fatal("publisher not invoked")
    }
}

func TestPublish_BadToken(t *testing.T) {
    h := PublishHandler(&stubPub{}, "tok-abc")
    req := httptest.NewRequest("POST", "/v1/publish", bytes.NewReader([]byte("{}")))
    req.Header.Set("Authorization", "Bearer wrong")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != http.StatusUnauthorized {
        t.Fatalf("expected 401, got %d", w.Code)
    }
}

func TestPublish_RejectNonSkillType(t *testing.T) {
    h := PublishHandler(&stubPub{}, "tok-abc")
    body, _ := json.Marshal(map[string]string{"slug": "p", "type": "plugin", "version": "0.1.0", "description": "d", "source_path": "/x"})
    req := httptest.NewRequest("POST", "/v1/publish", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok-abc")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != http.StatusBadRequest {
        t.Fatalf("expected 400, got %d", w.Code)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/api/local/...`
Expected: FAIL — `PublishHandler` undefined

- [ ] **Step 3: Write minimal implementation**

```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "encoding/json"
    "net/http"

    "claude-hub/agent/internal/jobs"
)

type Publisher interface {
    Publish(req jobs.PublishRequest) (*jobs.PublishResult, error)
}

type publishBody struct {
    Slug        string `json:"slug"`
    Type        string `json:"type"`
    Version     string `json:"version"`
    Description string `json:"description"`
    SourcePath  string `json:"source_path"`
}

func PublishHandler(p Publisher, expectedToken string) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !checkToken(r, expectedToken) {
            http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
            return
        }
        var body publishBody
        if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
            http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
            return
        }
        if body.Type != "skill" {
            http.Error(w, `{"error":"only skill in MVP"}`, http.StatusBadRequest)
            return
        }
        res, err := p.Publish(jobs.PublishRequest{
            Slug: body.Slug, Type: body.Type, Version: body.Version,
            Description: body.Description, SourcePath: body.SourcePath,
        })
        if err != nil {
            http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
            return
        }
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(map[string]string{
            "artifactId": res.ArtifactID, "versionId": res.VersionID,
        })
    })
}

func checkToken(r *http.Request, expected string) bool {
    auth := r.Header.Get("Authorization")
    return auth == "Bearer "+expected
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/api/local/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/api/local/publish.go apps/agent/internal/api/local/publish_test.go
git commit -m "feat(agent): add local /v1/publish endpoint with bearer auth"
```

---

### Task 28: POST /v1/install local endpoint

**Files:**
- Create: `apps/agent/internal/api/local/install.go`
- Test: `apps/agent/internal/api/local/install_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "claude-hub/agent/internal/jobs"
)

type stubInstaller struct{ got jobs.InstallRequest }

func (s *stubInstaller) Install(req jobs.InstallRequest) error {
    s.got = req
    return nil
}

func TestInstall_HappyPath(t *testing.T) {
    inst := &stubInstaller{}
    hubMux := http.NewServeMux()
    hubMux.HandleFunc("/api/artifacts/", func(w http.ResponseWriter, r *http.Request) {
        _ = json.NewEncoder(w).Encode(map[string]string{
            "downloadUrl": "https://blob/x.tar.gz",
            "sha256":      "a" + string(make([]byte, 63)),
        })
    })
    hub := httptest.NewServer(hubMux)
    defer hub.Close()

    h := InstallHandler(inst, hub.URL, hub.Client(), "tok", "/skills")
    body, _ := json.Marshal(map[string]string{
        "artifact_slug": "foo", "version": "0.1.0",
    })
    req := httptest.NewRequest("POST", "/v1/install", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != 200 {
        t.Fatalf("status %d body %s", w.Code, w.Body.String())
    }
    if inst.got.DownloadURL != "https://blob/x.tar.gz" {
        t.Fatalf("forwarded URL wrong: %+v", inst.got)
    }
}

func TestInstall_HubErrorReturns502(t *testing.T) {
    hubMux := http.NewServeMux()
    hubMux.HandleFunc("/api/artifacts/", func(w http.ResponseWriter, r *http.Request) {
        http.Error(w, "no", 404)
    })
    hub := httptest.NewServer(hubMux)
    defer hub.Close()

    h := InstallHandler(&stubInstaller{}, hub.URL, hub.Client(), "tok", "/skills")
    body, _ := json.Marshal(map[string]string{"artifact_slug": "foo", "version": "0.1.0"})
    req := httptest.NewRequest("POST", "/v1/install", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != http.StatusBadGateway {
        t.Fatalf("expected 502, got %d", w.Code)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/api/local/...`
Expected: FAIL — `InstallHandler` undefined

- [ ] **Step 3: Write minimal implementation**

```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "encoding/json"
    "fmt"
    "net/http"
    "path/filepath"

    "claude-hub/agent/internal/jobs"
)

type Installer interface {
    Install(req jobs.InstallRequest) error
}

type installBody struct {
    ArtifactSlug string `json:"artifact_slug"`
    Version      string `json:"version"`
}

func InstallHandler(inst Installer, hubURL string, hubClient *http.Client, token, skillsRoot string) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !checkToken(r, token) {
            http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
            return
        }
        var body installBody
        if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
            http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
            return
        }
        url := fmt.Sprintf("%s/api/artifacts/%s/versions/%s/download", hubURL, body.ArtifactSlug, body.Version)
        req, _ := http.NewRequest("GET", url, nil)
        req.Header.Set("Authorization", "Bearer "+token)
        resp, err := hubClient.Do(req)
        if err != nil {
            http.Error(w, `{"error":"hub unreachable"}`, http.StatusBadGateway)
            return
        }
        defer resp.Body.Close()
        if resp.StatusCode != 200 {
            http.Error(w, `{"error":"hub error"}`, http.StatusBadGateway)
            return
        }
        var meta struct {
            DownloadURL string `json:"downloadUrl"`
            Sha256      string `json:"sha256"`
        }
        if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
            http.Error(w, `{"error":"bad hub response"}`, http.StatusBadGateway)
            return
        }
        target := filepath.Join(skillsRoot, body.ArtifactSlug)
        if err := inst.Install(jobs.InstallRequest{
            DownloadURL: meta.DownloadURL,
            Sha256:      meta.Sha256,
            TargetPath:  target,
        }); err != nil {
            http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
            return
        }
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": target})
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/api/local/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/api/local/install.go apps/agent/internal/api/local/install_test.go
git commit -m "feat(agent): add local /v1/install endpoint that brokers via hub"
```

---

### Task 29: POST /v1/uninstall local endpoint

**Files:**
- Create: `apps/agent/internal/api/local/uninstall.go`
- Test: `apps/agent/internal/api/local/uninstall_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "bytes"
    "encoding/json"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestUninstall_MovesToBackup(t *testing.T) {
    skillsRoot := t.TempDir()
    target := filepath.Join(skillsRoot, "foo")
    if err := os.MkdirAll(target, 0o755); err != nil {
        t.Fatal(err)
    }
    if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte("x"), 0o644); err != nil {
        t.Fatal(err)
    }

    h := UninstallHandler(skillsRoot, "tok")
    body, _ := json.Marshal(map[string]string{"slug": "foo"})
    req := httptest.NewRequest("POST", "/v1/uninstall", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != 200 {
        t.Fatalf("code: %d", w.Code)
    }
    if _, err := os.Stat(target); !os.IsNotExist(err) {
        t.Fatal("expected target removed")
    }
    backups, _ := os.ReadDir(filepath.Join(skillsRoot, ".claude-hub-backup"))
    if len(backups) != 1 {
        t.Fatalf("expected 1 backup, got %d", len(backups))
    }
}

func TestUninstall_NotFound(t *testing.T) {
    skillsRoot := t.TempDir()
    h := UninstallHandler(skillsRoot, "tok")
    body, _ := json.Marshal(map[string]string{"slug": "missing"})
    req := httptest.NewRequest("POST", "/v1/uninstall", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != 404 {
        t.Fatalf("expected 404, got %d", w.Code)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/api/local/...`
Expected: FAIL — `UninstallHandler` undefined

- [ ] **Step 3: Write minimal implementation**

```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "path/filepath"
    "time"
)

type uninstallBody struct {
    Slug string `json:"slug"`
}

func UninstallHandler(skillsRoot, token string) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !checkToken(r, token) {
            http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
            return
        }
        var body uninstallBody
        if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
            http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
            return
        }
        target := filepath.Join(skillsRoot, body.Slug)
        if _, err := os.Stat(target); os.IsNotExist(err) {
            http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
            return
        }
        backupRoot := filepath.Join(skillsRoot, ".claude-hub-backup")
        if err := os.MkdirAll(backupRoot, 0o755); err != nil {
            http.Error(w, `{"error":"backup dir"}`, http.StatusInternalServerError)
            return
        }
        backupDir := filepath.Join(backupRoot, fmt.Sprintf("%s-%d", body.Slug, time.Now().Unix()))
        if err := os.Rename(target, backupDir); err != nil {
            http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
            return
        }
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "backup": backupDir})
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/api/local/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/api/local/uninstall.go apps/agent/internal/api/local/uninstall_test.go
git commit -m "feat(agent): add local /v1/uninstall endpoint with backup"
```

---

### Task 30: POST /v1/toggle — MVP no-op for skills

**Files:**
- Create: `apps/agent/internal/api/local/toggle.go`
- Test: `apps/agent/internal/api/local/toggle_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "bytes"
    "encoding/json"
    "net/http/httptest"
    "testing"
)

type stubRegistry struct{ items map[string]string } // artifactId -> type

func (s *stubRegistry) FindByArtifactID(id string) (string, bool) {
    t, ok := s.items[id]
    return t, ok
}

func TestToggle_SkillReturns400(t *testing.T) {
    reg := &stubRegistry{items: map[string]string{"a-1": "skill"}}
    h := ToggleHandler(reg, "tok")
    body, _ := json.Marshal(map[string]any{"artifact_id": "a-1", "enabled": false})
    req := httptest.NewRequest("POST", "/v1/toggle", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != 400 {
        t.Fatalf("expected 400, got %d", w.Code)
    }
    var resp map[string]string
    _ = json.Unmarshal(w.Body.Bytes(), &resp)
    if resp["error"] != "skills don't support toggle in MVP" {
        t.Fatalf("error msg: %+v", resp)
    }
}

func TestToggle_NotFound(t *testing.T) {
    reg := &stubRegistry{items: map[string]string{}}
    h := ToggleHandler(reg, "tok")
    body, _ := json.Marshal(map[string]any{"artifact_id": "missing", "enabled": true})
    req := httptest.NewRequest("POST", "/v1/toggle", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != 404 {
        t.Fatalf("expected 404, got %d", w.Code)
    }
}

func TestToggle_NonSkillTypeNotSupportedYet(t *testing.T) {
    reg := &stubRegistry{items: map[string]string{"p-1": "plugin"}}
    h := ToggleHandler(reg, "tok")
    body, _ := json.Marshal(map[string]any{"artifact_id": "p-1", "enabled": true})
    req := httptest.NewRequest("POST", "/v1/toggle", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != 501 {
        t.Fatalf("expected 501 (not implemented in Plan 3), got %d", w.Code)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./internal/api/local/...`
Expected: FAIL — `ToggleHandler` undefined

- [ ] **Step 3: Write minimal implementation**

```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "encoding/json"
    "net/http"
)

type Registry interface {
    FindByArtifactID(id string) (string, bool)
}

type toggleBody struct {
    ArtifactID string `json:"artifact_id"`
    Enabled    bool   `json:"enabled"`
}

func ToggleHandler(reg Registry, token string) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !checkToken(r, token) {
            http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
            return
        }
        var body toggleBody
        if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
            http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
            return
        }
        artType, ok := reg.FindByArtifactID(body.ArtifactID)
        if !ok {
            http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
            return
        }
        if artType == "skill" {
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusBadRequest)
            _ = json.NewEncoder(w).Encode(map[string]string{
                "error": "skills don't support toggle in MVP",
            })
            return
        }
        // Plugin/command/agent toggle handled in Plan 4.
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusNotImplemented)
        _ = json.NewEncoder(w).Encode(map[string]string{
            "error": "type not supported in Plan 3",
        })
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./internal/api/local/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/api/local/toggle.go apps/agent/internal/api/local/toggle_test.go
git commit -m "feat(agent): add /v1/toggle stub returning 400 for skills, 501 for others"
```

---

## Sekce H — Server broker endpoints

### Task 31: POST /api/local/:daemonId/publish-request

**Files:**
- Create: `apps/hub-server/src/routes/local/publish-request.ts`
- Test: `apps/hub-server/test/integration/local-publish-request.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, pairFakeDaemon, attachFakeDaemonReply } from '../helpers/auth';

describe('POST /api/local/:daemonId/publish-request', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('forwards job.package and returns daemon result', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const { daemonId } = await pairFakeDaemon(srv, cookie);
    attachFakeDaemonReply(srv, daemonId, () => ({ ok: true, data: { artifactId: 'a-1', versionId: 'v-1' } }));
    const r = await fetch(`${srv.url}/api/local/${daemonId}/publish-request`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'foo', type: 'skill', version: '0.1.0',
        description: 'd', sourcePath: '/x',
      }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ artifactId: 'a-1', versionId: 'v-1' });
  });

  it('returns 403 when daemon belongs to another user', async () => {
    const aliceCookie = await loginAs(srv, 'alice@example.com');
    const { daemonId } = await pairFakeDaemon(srv, aliceCookie);
    const bobCookie = await loginAs(srv, 'bob@example.com');
    const r = await fetch(`${srv.url}/api/local/${daemonId}/publish-request`, {
      method: 'POST',
      headers: { cookie: bobCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'x', type: 'skill', version: '0.1.0', description: 'd', sourcePath: '/x' }),
    });
    expect(r.status).toBe(403);
  });

  it('returns 503 when daemon is offline', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const { daemonId } = await pairFakeDaemon(srv, cookie, { online: false });
    const r = await fetch(`${srv.url}/api/local/${daemonId}/publish-request`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'x', type: 'skill', version: '0.1.0', description: 'd', sourcePath: '/x' }),
    });
    expect(r.status).toBe(503);
  });

  it('rejects non-skill type with 400', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const { daemonId } = await pairFakeDaemon(srv, cookie);
    const r = await fetch(`${srv.url}/api/local/${daemonId}/publish-request`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'x', type: 'plugin', version: '0.1.0', description: 'd', sourcePath: '/x' }),
    });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/local-publish-request.test.ts`
Expected: FAIL with 404 on broker endpoint

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { daemons } from '../../db/schema/daemons';
import { sendJob } from '../../ws/jobs';
import { gateway } from '../../ws/gateway';
import { requireAuth } from '../../middleware/auth';
import { slugSchema, semverSchema, artifactTypeSchema } from '../../lib/validators';

const bodySchema = z.object({
  slug: slugSchema,
  type: artifactTypeSchema,
  version: semverSchema,
  description: z.string().min(1),
  sourcePath: z.string().min(1),
});

export const publishRequestRoute = new Hono().post(
  '/:daemonId/publish-request',
  requireAuth,
  async (c) => {
    const user = c.get('user');
    const daemonId = c.req.param('daemonId');
    const [d] = await db
      .select()
      .from(daemons)
      .where(and(eq(daemons.id, daemonId), eq(daemons.userId, user.id)))
      .limit(1);
    if (!d) return c.json({ error: 'forbidden' }, 403);
    const body = bodySchema.parse(await c.req.json());
    if (body.type !== 'skill') {
      return c.json({ error: 'only skill in MVP' }, 400);
    }
    try {
      const result = await sendJob(gateway, daemonId, 'job.package', body, 60_000);
      if (!result.ok) return c.json({ error: result.error ?? 'job failed' }, 502);
      return c.json(result.data ?? {});
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'unknown';
      if (msg === 'daemon offline') return c.json({ error: 'daemon offline' }, 503);
      throw e;
    }
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/local-publish-request.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/local/publish-request.ts apps/hub-server/test/integration/local-publish-request.test.ts
git commit -m "feat(server): add publish-request broker endpoint that delegates to daemon"
```

---

### Task 32: POST /api/install-request

**Files:**
- Create: `apps/hub-server/src/routes/local/install-request.ts`
- Test: `apps/hub-server/test/integration/install-request.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, seedArtifact, pairFakeDaemon, attachFakeDaemonReply } from '../helpers/auth';

describe('POST /api/install-request', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('happy path inserts install_event and returns ok', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const seeded = await seedArtifact(srv, cookie, { slug: 'inst', type: 'skill', description: 'd', version: '0.1.0' });
    const { daemonId } = await pairFakeDaemon(srv, cookie);
    attachFakeDaemonReply(srv, daemonId, () => ({ ok: true }));

    const r = await fetch(`${srv.url}/api/install-request`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: seeded.artifactId, version: '0.1.0', daemonId }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });

    const ev = await srv.db.query.installEvents.findMany({ where: { daemonId } } as never);
    expect(ev.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 403 for cross-user daemon', async () => {
    const aliceCookie = await loginAs(srv, 'alice@example.com');
    const seeded = await seedArtifact(srv, aliceCookie, { slug: 'inst2', type: 'skill', description: 'd', version: '0.1.0' });
    const { daemonId } = await pairFakeDaemon(srv, aliceCookie);
    const bobCookie = await loginAs(srv, 'bob@example.com');
    const r = await fetch(`${srv.url}/api/install-request`, {
      method: 'POST',
      headers: { cookie: bobCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: seeded.artifactId, version: '0.1.0', daemonId }),
    });
    expect(r.status).toBe(403);
  });

  it('returns 503 when daemon offline', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const seeded = await seedArtifact(srv, cookie, { slug: 'inst3', type: 'skill', description: 'd', version: '0.1.0' });
    const { daemonId } = await pairFakeDaemon(srv, cookie, { online: false });
    const r = await fetch(`${srv.url}/api/install-request`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: seeded.artifactId, version: '0.1.0', daemonId }),
    });
    expect(r.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/install-request.test.ts`
Expected: FAIL with 404 on install-request endpoint

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { artifacts, artifactVersions, installEvents } from '../../db/schema/artifacts';
import { daemons } from '../../db/schema/daemons';
import { presignDownload } from '../../storage/minio';
import { sendJob } from '../../ws/jobs';
import { gateway } from '../../ws/gateway';
import { requireAuth } from '../../middleware/auth';
import { semverSchema } from '../../lib/validators';

const bodySchema = z.object({
  artifactId: z.string().uuid(),
  version: semverSchema,
  daemonId: z.string().uuid(),
});

export const installRequestRoute = new Hono().post(
  '/install-request',
  requireAuth,
  async (c) => {
    const user = c.get('user');
    const body = bodySchema.parse(await c.req.json());
    const [d] = await db
      .select()
      .from(daemons)
      .where(and(eq(daemons.id, body.daemonId), eq(daemons.userId, user.id)))
      .limit(1);
    if (!d) return c.json({ error: 'forbidden' }, 403);

    const [v] = await db
      .select({
        id: artifactVersions.id,
        key: artifactVersions.storageKey,
        sha: artifactVersions.sha256,
        slug: artifacts.slug,
        type: artifacts.type,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(
        and(
          eq(artifactVersions.artifactId, body.artifactId),
          eq(artifactVersions.version, body.version),
        ),
      )
      .limit(1);
    if (!v) return c.json({ error: 'not found' }, 404);

    const url = await presignDownload(v.key, 300);
    const targetPath = `~/.claude/skills/${v.slug}`;
    try {
      const result = await sendJob(
        gateway,
        body.daemonId,
        'job.install',
        {
          artifactVersionId: v.id,
          type: v.type,
          slug: v.slug,
          version: body.version,
          sha256: v.sha,
          downloadUrl: url,
          targetPath,
        },
        120_000,
      );
      await db.insert(installEvents).values({
        daemonId: body.daemonId,
        artifactVersionId: v.id,
        status: result.ok ? 'success' : 'failed',
      });
      if (!result.ok) return c.json({ error: result.error }, 502);
      return c.json({ ok: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'unknown';
      if (msg === 'daemon offline') return c.json({ error: 'daemon offline' }, 503);
      throw e;
    }
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/install-request.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/local/install-request.ts apps/hub-server/test/integration/install-request.test.ts
git commit -m "feat(server): add install-request broker endpoint with install_event audit"
```

---

## Sekce I — Dashboard pages

### Task 33: useHubSocket hook with reconnect

**Files:**
- Create: `apps/dashboard/src/lib/use-hub-socket.ts`
- Test: `apps/dashboard/src/lib/use-hub-socket.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHubSocket } from './use-hub-socket';

class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

describe('useHubSocket', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('connects, parses messages, reconnects on close with backoff', () => {
    const onMessage = vi.fn();
    renderHook(() => useHubSocket('ws://x', onMessage));
    expect(FakeWS.instances).toHaveLength(1);
    act(() => { FakeWS.instances[0].open(); });
    act(() => {
      FakeWS.instances[0].message({
        type: 'catalog.update',
        id: '1',
        payload: { artifactId: 'a', slug: 's', type: 'skill', version: '0.1.0' },
      });
    });
    expect(onMessage).toHaveBeenCalledTimes(1);

    act(() => { FakeWS.instances[0].close(); });
    act(() => { vi.advanceTimersByTime(150); });
    expect(FakeWS.instances).toHaveLength(2);
    act(() => { FakeWS.instances[1].close(); });
    act(() => { vi.advanceTimersByTime(250); });
    expect(FakeWS.instances).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dashboard vitest run src/lib/use-hub-socket.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useEffect, useRef, useState } from 'react';
import { parseMessage, type WssMessage } from '@hub/wss-protocol';

export type HubSocketStatus = 'connecting' | 'open' | 'closed';

export function useHubSocket(
  url: string,
  onMessage: (m: WssMessage) => void,
): { status: HubSocketStatus; send: (m: WssMessage) => void } {
  const [status, setStatus] = useState<HubSocketStatus>('connecting');
  const sockRef = useRef<WebSocket | null>(null);
  const sendRef = useRef<(m: WssMessage) => void>(() => {});

  useEffect(() => {
    let attempt = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const s = new WebSocket(url);
      sockRef.current = s;
      setStatus('connecting');
      s.onopen = () => {
        setStatus('open');
        attempt = 0;
      };
      s.onmessage = (e) => {
        try {
          onMessage(parseMessage(JSON.parse(e.data)));
        } catch {
          // ignore parse errors
        }
      };
      s.onclose = () => {
        setStatus('closed');
        if (!cancelled) {
          const delay = Math.min(10_000, 100 * 2 ** attempt);
          attempt += 1;
          timer = setTimeout(connect, delay);
        }
      };
      sendRef.current = (m) => {
        if (s.readyState === 1) s.send(JSON.stringify(m));
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sockRef.current?.close();
    };
  }, [url, onMessage]);

  return { status, send: (m) => sendRef.current(m) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dashboard vitest run src/lib/use-hub-socket.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/use-hub-socket.ts apps/dashboard/src/lib/use-hub-socket.test.tsx
git commit -m "feat(dashboard): add useHubSocket hook with exponential reconnect backoff"
```

---

### Task 34: /local page — inventory table + Publish modal

**Files:**
- Create: `apps/dashboard/src/app/local/page.tsx`
- Create: `apps/dashboard/src/components/local/inventory-table.tsx`
- Create: `apps/dashboard/src/components/local/publish-dialog.tsx`
- Test: `apps/dashboard/src/components/local/inventory-table.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InventoryTable } from './inventory-table';

describe('InventoryTable', () => {
  it('renders rows for each item with Publish action when not published', () => {
    const onPublish = vi.fn();
    render(
      <InventoryTable
        items={[
          { type: 'skill', slug: 'foo', version: null, path: '/x', enabled: null },
          { type: 'skill', slug: 'bar', version: '0.1.0', path: '/y', enabled: null,
            publishedAs: { artifactId: 'a-1', version: '0.1.0' } },
        ]}
        onPublish={onPublish}
      />,
    );
    expect(screen.getByText('foo')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
    const publishBtns = screen.getAllByRole('button', { name: /publish/i });
    expect(publishBtns).toHaveLength(1);
    fireEvent.click(publishBtns[0]);
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ slug: 'foo' }));
  });

  it('shows empty state when no items', () => {
    render(<InventoryTable items={[]} onPublish={() => {}} />);
    expect(screen.getByText(/no local artifacts/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dashboard vitest run src/components/local/inventory-table.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`apps/dashboard/src/components/local/inventory-table.tsx`:
```tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import type { InventoryItem } from '@hub/wss-protocol';
import { Button } from '@/components/ui/button';

export function InventoryTable({
  items,
  onPublish,
}: {
  items: InventoryItem[];
  onPublish: (item: InventoryItem) => void;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No local artifacts found.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2">Type</th>
          <th>Slug</th>
          <th>Version</th>
          <th>Path</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={`${i.type}:${i.slug}`} className="border-b">
            <td className="py-2">{i.type}</td>
            <td>{i.slug}</td>
            <td>{i.version ?? '—'}</td>
            <td className="font-mono text-xs">{i.path}</td>
            <td>
              {i.publishedAs ? (
                <span className="text-muted-foreground">
                  Published as @{i.publishedAs.version}
                </span>
              ) : (
                <Button size="sm" onClick={() => onPublish(i)}>
                  Publish
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`apps/dashboard/src/components/local/publish-dialog.tsx`:
```tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useState } from 'react';
import type { InventoryItem } from '@hub/wss-protocol';
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function PublishDialog({
  open,
  item,
  daemonId,
  onClose,
  onSuccess,
}: {
  open: boolean;
  item: InventoryItem | null;
  daemonId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [version, setVersion] = useState('0.1.0');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/local/${daemonId}/publish-request`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: item.slug,
          type: item.type,
          version,
          description,
          sourcePath: item.path,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      onSuccess();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogTitle>Publish {item?.slug}</DialogTitle>
        <div className="space-y-3">
          <label className="block text-sm">
            Version
            <Input value={version} onChange={(e) => setVersion(e.target.value)} />
          </label>
          <label className="block text-sm">
            Description
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !description}>
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`apps/dashboard/src/app/local/page.tsx`:
```tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DaemonDTO } from '@hub/shared-types';
import type { InventoryItem, WssMessage } from '@hub/wss-protocol';
import { useHubSocket } from '@/lib/use-hub-socket';
import { InventoryTable } from '@/components/local/inventory-table';
import { PublishDialog } from '@/components/local/publish-dialog';

export default function LocalPage() {
  const qc = useQueryClient();
  const { data: daemons } = useQuery<DaemonDTO[]>({
    queryKey: ['daemons'],
    queryFn: () => fetch('/api/daemons', { credentials: 'include' }).then((r) => r.json()),
  });
  const onlineDaemon = useMemo(() => daemons?.find((d) => d.online), [daemons]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [publishItem, setPublishItem] = useState<InventoryItem | null>(null);

  const handleMessage = useCallback(
    (m: WssMessage) => {
      if (m.type === 'local.snapshot' && m.payload.daemonId === onlineDaemon?.id) {
        setItems(m.payload.items);
      } else if (m.type === 'local.delta' && m.payload.daemonId === onlineDaemon?.id) {
        setItems((prev) => {
          const removed = new Set(m.payload.removed.map((r) => `${r.type}:${r.slug}`));
          const modIndex = new Map(m.payload.modified.map((x) => [`${x.type}:${x.slug}`, x]));
          const filtered = prev.filter((i) => !removed.has(`${i.type}:${i.slug}`));
          const merged = filtered.map((i) => modIndex.get(`${i.type}:${i.slug}`) ?? i);
          return [...merged, ...m.payload.added];
        });
      } else if (m.type === 'catalog.update') {
        qc.invalidateQueries({ queryKey: ['artifacts'] });
      }
    },
    [onlineDaemon?.id, qc],
  );

  const wsUrl =
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
      : '';
  const { send, status } = useHubSocket(wsUrl, handleMessage);

  useEffect(() => {
    if (status === 'open' && onlineDaemon) {
      send({ type: 'subscribe.local', id: crypto.randomUUID(), payload: { daemonId: onlineDaemon.id } });
    }
  }, [status, onlineDaemon, send]);

  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Local artifacts</h1>
      {!onlineDaemon && <p className="text-sm text-muted-foreground">No daemon online.</p>}
      <InventoryTable items={items} onPublish={setPublishItem} />
      <PublishDialog
        open={publishItem !== null}
        item={publishItem}
        daemonId={onlineDaemon?.id ?? ''}
        onClose={() => setPublishItem(null)}
        onSuccess={() => qc.invalidateQueries({ queryKey: ['artifacts'] })}
      />
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dashboard vitest run src/components/local/inventory-table.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/app/local/page.tsx apps/dashboard/src/components/local/inventory-table.tsx apps/dashboard/src/components/local/publish-dialog.tsx apps/dashboard/src/components/local/inventory-table.test.tsx
git commit -m "feat(dashboard): add /local page with live inventory and publish flow"
```

---

### Task 35: /catalog page — list + filters

**Files:**
- Create: `apps/dashboard/src/app/catalog/page.tsx`
- Create: `apps/dashboard/src/components/catalog/catalog-table.tsx`
- Test: `apps/dashboard/src/components/catalog/catalog-table.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CatalogTable } from './catalog-table';

describe('CatalogTable', () => {
  it('renders rows for each artifact', () => {
    render(
      <CatalogTable
        items={[
          { id: 'a-1', slug: 'foo', type: 'skill', description: 'desc', latestVersion: '0.1.0' },
          { id: 'a-2', slug: 'bar', type: 'plugin', description: 'plug', latestVersion: null },
        ]}
      />,
    );
    expect(screen.getByText('foo')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    render(<CatalogTable items={[]} />);
    expect(screen.getByText(/no artifacts published/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dashboard vitest run src/components/catalog/catalog-table.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`apps/dashboard/src/components/catalog/catalog-table.tsx`:
```tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import Link from 'next/link';

export type CatalogRow = {
  id: string;
  slug: string;
  type: string;
  description: string;
  latestVersion: string | null;
};

export function CatalogTable({ items }: { items: CatalogRow[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No artifacts published yet.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2">Slug</th>
          <th>Type</th>
          <th>Description</th>
          <th>Latest version</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} className="border-b hover:bg-muted/40">
            <td className="py-2">
              <Link href={`/catalog/${i.slug}`} className="underline">
                {i.slug}
              </Link>
            </td>
            <td>{i.type}</td>
            <td>{i.description}</td>
            <td>{i.latestVersion ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`apps/dashboard/src/app/catalog/page.tsx`:
```tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CatalogTable, type CatalogRow } from '@/components/catalog/catalog-table';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { useDebounce } from '@/lib/use-debounce';

export default function CatalogPage() {
  const [type, setType] = useState<string>('all');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['artifacts', type, debouncedQ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (type !== 'all') params.set('type', type);
      if (debouncedQ) params.set('q', debouncedQ);
      const r = await fetch(`/api/artifacts?${params.toString()}`, { credentials: 'include' });
      return r.json() as Promise<{ items: CatalogRow[]; total: number }>;
    },
  });

  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Team catalog</h1>
      <div className="flex gap-3">
        <Input placeholder="Search description" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="skill">Skill</SelectItem>
            <SelectItem value="plugin">Plugin</SelectItem>
            <SelectItem value="command">Command</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {isLoading ? <p>Loading…</p> : <CatalogTable items={data?.items ?? []} />}
    </main>
  );
}
```

`apps/dashboard/src/lib/use-debounce.ts`:
```ts
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';

export function useDebounce<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dashboard vitest run src/components/catalog/catalog-table.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/app/catalog/page.tsx apps/dashboard/src/components/catalog/catalog-table.tsx apps/dashboard/src/components/catalog/catalog-table.test.tsx apps/dashboard/src/lib/use-debounce.ts
git commit -m "feat(dashboard): add /catalog list page with filters"
```

---

### Task 36: /catalog/[slug] detail with Install button

**Files:**
- Create: `apps/dashboard/src/app/catalog/[slug]/page.tsx`
- Create: `apps/dashboard/src/components/catalog/install-button.tsx`
- Test: `apps/dashboard/src/components/catalog/install-button.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InstallButton } from './install-button';

describe('InstallButton', () => {
  it('POSTs to /api/install-request with correct body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<InstallButton artifactId="a-1" version="0.1.0" daemonId="d-1" />);
    fireEvent.click(screen.getByRole('button', { name: /install/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ artifactId: 'a-1', version: '0.1.0', daemonId: 'd-1' });
    vi.unstubAllGlobals();
  });

  it('shows error on failure', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'daemon offline' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<InstallButton artifactId="a-1" version="0.1.0" daemonId="d-1" />);
    fireEvent.click(screen.getByRole('button', { name: /install/i }));
    await waitFor(() => expect(screen.getByText(/daemon offline/i)).toBeInTheDocument());
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dashboard vitest run src/components/catalog/install-button.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`apps/dashboard/src/components/catalog/install-button.tsx`:
```tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function InstallButton({
  artifactId,
  version,
  daemonId,
}: {
  artifactId: string;
  version: string;
  daemonId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/install-request', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifactId, version, daemonId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setDone(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button onClick={install} disabled={busy || done}>
        {done ? 'Installed' : busy ? 'Installing…' : 'Install'}
      </Button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

`apps/dashboard/src/app/catalog/[slug]/page.tsx`:
```tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import { use, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DaemonDTO } from '@hub/shared-types';
import { InstallButton } from '@/components/catalog/install-button';

type Props = { params: Promise<{ slug: string }> };

export default function CatalogDetailPage({ params }: Props) {
  const { slug } = use(params);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  const { data: detail } = useQuery({
    queryKey: ['artifact', slug],
    queryFn: () =>
      fetch(`/api/artifacts/${slug}`, { credentials: 'include' }).then((r) => r.json()),
  });
  const { data: daemons } = useQuery<DaemonDTO[]>({
    queryKey: ['daemons'],
    queryFn: () => fetch('/api/daemons', { credentials: 'include' }).then((r) => r.json()),
  });

  if (!detail) return <p>Loading…</p>;
  const versions: { id: string; version: string; deprecated: boolean }[] = detail.versions ?? [];
  const onlineDaemon = daemons?.find((d) => d.online);
  const latest = versions.find((v) => !v.deprecated) ?? versions[0];

  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">{detail.artifact.slug}</h1>
      <p className="text-muted-foreground">{detail.artifact.description}</p>
      <h2 className="text-lg font-semibold mt-4">Versions</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left"><th>Version</th><th>Status</th></tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} className="border-b">
              <td className="py-2">{v.version}{v === latest && ' (latest)'}</td>
              <td>{v.deprecated ? 'deprecated' : 'active'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {onlineDaemon && latest && (
        <InstallButton
          artifactId={detail.artifact.id}
          version={selectedVersion ?? latest.version}
          daemonId={onlineDaemon.id}
        />
      )}
      {!onlineDaemon && (
        <p className="text-sm text-muted-foreground">Connect a daemon to install.</p>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dashboard vitest run src/components/catalog/install-button.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/app/catalog/[slug]/page.tsx apps/dashboard/src/components/catalog/install-button.tsx apps/dashboard/src/components/catalog/install-button.test.tsx
git commit -m "feat(dashboard): add catalog detail page with install action"
```

---

### Task 37: Live catalog.update invalidation

**Files:**
- Modify: `apps/dashboard/src/app/providers.tsx` (root provider hook)
- Test: `apps/dashboard/src/app/providers.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCatalogLiveUpdates } from './providers';

describe('useCatalogLiveUpdates', () => {
  it('invalidates artifacts query on catalog.update message', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCatalogLiveUpdates(), { wrapper });
    act(() => {
      result.current.handleMessage({
        type: 'catalog.update',
        id: '1',
        payload: { artifactId: 'a', slug: 's', type: 'skill', version: '0.1.0' },
      });
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['artifacts'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dashboard vitest run src/app/providers.test.tsx`
Expected: FAIL — `useCatalogLiveUpdates` not exported

- [ ] **Step 3: Add hook + wire it in providers**

```tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WssMessage } from '@hub/wss-protocol';

export function useCatalogLiveUpdates() {
  const qc = useQueryClient();
  const handleMessage = useCallback(
    (m: WssMessage) => {
      if (m.type === 'catalog.update') {
        qc.invalidateQueries({ queryKey: ['artifacts'] });
      }
    },
    [qc],
  );
  return { handleMessage };
}
```

Hook the result into a top-level component that holds a single `useHubSocket(wsUrl, handleMessage)` so all pages benefit. Suggested location: `apps/dashboard/src/app/(dashboard)/layout.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dashboard vitest run src/app/providers.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/app/providers.tsx apps/dashboard/src/app/providers.test.tsx
git commit -m "feat(dashboard): live catalog updates via WSS catalog.update"
```

---

## Sekce J — Integration & E2E tests

### Task 38: Server integration — publish round-trip

**Files:**
- Create: `apps/hub-server/test/integration/publish-flow.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, packageDirToTarGz } from '../helpers/auth';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('publish round-trip', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('uploads tar.gz and round-trips download with matching sha', async () => {
    const cookie = await loginAs(srv, 'alice@example.com');
    const skillDir = mkdtempSync(join(tmpdir(), 'skill-'));
    mkdirSync(join(skillDir, 'helper'), { recursive: true });
    writeFileSync(join(skillDir, 'helper', 'SKILL.md'), '---\nname: helper\ndescription: d\n---\nbody\n');
    const tarBytes = await packageDirToTarGz(join(skillDir, 'helper'));
    const sha = createHash('sha256').update(tarBytes).digest('hex');

    const form = new FormData();
    form.set('slug', 'helper');
    form.set('type', 'skill');
    form.set('version', '0.1.0');
    form.set('description', 'd');
    form.set('sha256', sha);
    form.set('manifest', JSON.stringify({
      schemaVersion: 1, name: 'helper', type: 'skill', description: 'd', typeMeta: {},
    }));
    form.set('file', new Blob([tarBytes], { type: 'application/gzip' }), 'helper.tar.gz');

    const r = await fetch(`${srv.url}/api/artifacts/upload`, {
      method: 'POST', headers: { cookie }, body: form,
    });
    expect(r.status).toBe(201);
    const { artifactId, versionId } = await r.json();
    expect(artifactId).toBeTruthy();
    expect(versionId).toBeTruthy();

    const dl = await fetch(`${srv.url}/api/artifacts/helper/versions/0.1.0/download`, {
      headers: { cookie },
    });
    expect(dl.status).toBe(200);
    const meta = await dl.json();
    expect(meta.sha256).toBe(sha);

    const blob = await fetch(meta.downloadUrl);
    const buf = Buffer.from(await blob.arrayBuffer());
    expect(createHash('sha256').update(buf).digest('hex')).toBe(sha);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes if all upstream tasks done)**

Run: `pnpm --filter hub-server vitest run test/integration/publish-flow.test.ts`
Expected: PASS once Tasks 6, 8, 10 are wired through `helpers/test-server.ts`.

- [ ] **Step 3: If failing, complete missing helpers in `apps/hub-server/test/helpers/auth.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function packageDirToTarGz(dir: string): Promise<Buffer> {
  const out = join(mkdtempSync(join(tmpdir(), 'tgz-')), 'a.tar.gz');
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-czf', out, '-C', dir, '.']);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
  });
  return readFileSync(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/publish-flow.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/test/integration/publish-flow.test.ts apps/hub-server/test/helpers/auth.ts
git commit -m "test(server): add publish round-trip integration test"
```

---

### Task 39: Server integration — RBAC matrix

**Files:**
- Create: `apps/hub-server/test/integration/catalog-rbac-matrix.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';
import { loginAs, seedArtifact, promoteToAdmin } from '../helpers/auth';

describe('catalog RBAC matrix', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('member can yank own', async () => {
    const owner = await loginAs(srv, 'owner@example.com');
    await seedArtifact(srv, owner, { slug: 'mine-y', type: 'skill', description: 'd', version: '0.1.0' });
    const r = await fetch(`${srv.url}/api/artifacts/mine-y/yank`, { method: 'POST', headers: { cookie: owner } });
    expect(r.status).toBe(200);
  });

  it("member cannot yank another's artifact", async () => {
    const owner = await loginAs(srv, 'o5@example.com');
    await seedArtifact(srv, owner, { slug: 'their-y', type: 'skill', description: 'd', version: '0.1.0' });
    const other = await loginAs(srv, 'mem@example.com');
    const r = await fetch(`${srv.url}/api/artifacts/their-y/yank`, { method: 'POST', headers: { cookie: other } });
    expect(r.status).toBe(403);
  });

  it('member cannot DELETE artifact', async () => {
    const owner = await loginAs(srv, 'o6@example.com');
    await seedArtifact(srv, owner, { slug: 'arc-mem', type: 'skill', description: 'd', version: '0.1.0' });
    const r = await fetch(`${srv.url}/api/artifacts/arc-mem`, { method: 'DELETE', headers: { cookie: owner } });
    expect(r.status).toBe(403);
  });

  it('admin can DELETE', async () => {
    const owner = await loginAs(srv, 'o7@example.com');
    await seedArtifact(srv, owner, { slug: 'arc-adm', type: 'skill', description: 'd', version: '0.1.0' });
    await promoteToAdmin(srv, 'adm@example.com');
    const adm = await loginAs(srv, 'adm@example.com');
    const r = await fetch(`${srv.url}/api/artifacts/arc-adm`, { method: 'DELETE', headers: { cookie: adm } });
    expect(r.status).toBe(200);
  });

  it('member cannot upload non-skill type in MVP', async () => {
    const member = await loginAs(srv, 'mb@example.com');
    const form = new FormData();
    form.set('slug', 'plg');
    form.set('type', 'plugin');
    form.set('version', '0.1.0');
    form.set('description', 'd');
    form.set('sha256', 'a'.repeat(64));
    form.set('manifest', JSON.stringify({ schemaVersion: 1, name: 'plg', type: 'plugin', description: 'd', typeMeta: {} }));
    form.set('file', new Blob([Buffer.from('x')], { type: 'application/gzip' }), 'a.tar.gz');
    const r = await fetch(`${srv.url}/api/artifacts/upload`, { method: 'POST', headers: { cookie: member }, body: form });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes after sections C+H complete)**

Run: `pnpm --filter hub-server vitest run test/integration/catalog-rbac-matrix.test.ts`
Expected: PASS once all upstream RBAC enforcement tasks (Tasks 6, 11, 12) are merged.

- [ ] **Step 3: Fix any failures by adjusting upstream guards**

If a case fails, the failure points to a missing role check in the corresponding route handler. Patch the offending route and rerun.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/catalog-rbac-matrix.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/test/integration/catalog-rbac-matrix.test.ts
git commit -m "test(server): add RBAC matrix tests for catalog endpoints"
```

---

### Task 40: Daemon integration — publish via local API

**Files:**
- Create: `apps/agent/test/integration/publish_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package integration

import (
    "bytes"
    "encoding/json"
    "io"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"

    "claude-hub/agent/internal/api/local"
    "claude-hub/agent/internal/jobs"
)

func TestPublish_LocalAPIHitsHub(t *testing.T) {
    skillDir := t.TempDir()
    if err := os.MkdirAll(filepath.Join(skillDir, "demo"), 0o755); err != nil {
        t.Fatal(err)
    }
    if err := os.WriteFile(
        filepath.Join(skillDir, "demo", "SKILL.md"),
        []byte("---\nname: demo\ndescription: d\n---\n"), 0o644); err != nil {
        t.Fatal(err)
    }

    var receivedSlug string
    var receivedSha string
    hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/api/artifacts/upload" {
            t.Fatalf("unexpected path: %s", r.URL.Path)
        }
        if err := r.ParseMultipartForm(32 << 20); err != nil {
            t.Fatal(err)
        }
        receivedSlug = r.FormValue("slug")
        receivedSha = r.FormValue("sha256")
        f, _, err := r.FormFile("file")
        if err != nil {
            t.Fatal(err)
        }
        defer f.Close()
        _, _ = io.Copy(io.Discard, f)
        w.WriteHeader(201)
        _, _ = w.Write([]byte(`{"artifactId":"a-1","versionId":"v-1"}`))
    }))
    defer hub.Close()

    j := jobs.New(hub.URL, "tok-abc", skillDir)
    j.HTTPClient = hub.Client()

    // Local API: POST /v1/publish
    h := local.PublishHandler(j, "tok-abc")
    body, _ := json.Marshal(map[string]string{
        "slug": "demo", "type": "skill", "version": "0.1.0",
        "description": "d", "source_path": filepath.Join(skillDir, "demo"),
    })
    req := httptest.NewRequest("POST", "/v1/publish", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok-abc")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)

    if w.Code != 200 {
        t.Fatalf("status %d body %s", w.Code, w.Body.String())
    }
    if receivedSlug != "demo" {
        t.Fatalf("hub got slug=%s", receivedSlug)
    }
    if len(receivedSha) != 64 {
        t.Fatalf("sha256 length: %d", len(receivedSha))
    }
}
```

- [ ] **Step 2: Run test to verify it fails (or passes once Tasks 23, 24, 27 are merged)**

Run: `cd apps/agent && go test ./test/integration/...`
Expected: PASS once jobs.New and PublishHandler exist and are wired.

- [ ] **Step 3: Fix any wiring issues**

Inspect failing assertions and update either Tasks 23/24/27 implementations or this test's setup until all assertions pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./test/integration/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/test/integration/publish_test.go
git commit -m "test(agent): add local /v1/publish integration test against fake hub"
```

---

### Task 41: Daemon integration — install round-trip

**Files:**
- Create: `apps/agent/test/integration/install_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package integration

import (
    "archive/tar"
    "bytes"
    "compress/gzip"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"

    bytestest "bytes"

    "claude-hub/agent/internal/api/local"
    "claude-hub/agent/internal/jobs"
)

func makeSampleTarGz(t *testing.T) ([]byte, string) {
    t.Helper()
    buf := &bytes.Buffer{}
    gz := gzip.NewWriter(buf)
    tw := tar.NewWriter(gz)
    payload := "body"
    _ = tw.WriteHeader(&tar.Header{Name: "SKILL.md", Mode: 0o644, Size: int64(len(payload)), Typeflag: tar.TypeReg})
    _, _ = tw.Write([]byte(payload))
    _ = tw.Close()
    _ = gz.Close()
    h := sha256.New()
    h.Write(buf.Bytes())
    return buf.Bytes(), hex.EncodeToString(h.Sum(nil))
}

func TestInstall_RoundTrip(t *testing.T) {
    bytesGz, sha := makeSampleTarGz(t)
    blob := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _, _ = w.Write(bytesGz)
    }))
    defer blob.Close()

    hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _ = json.NewEncoder(w).Encode(map[string]string{
            "downloadUrl": blob.URL,
            "sha256":      sha,
        })
    }))
    defer hub.Close()

    home := t.TempDir()
    skillsRoot := filepath.Join(home, ".claude", "skills")
    _ = os.MkdirAll(skillsRoot, 0o755)
    j := jobs.New(hub.URL, "tok", skillsRoot)
    j.HTTPClient = hub.Client()

    h := local.InstallHandler(j, hub.URL, hub.Client(), "tok", skillsRoot)
    body, _ := json.Marshal(map[string]string{"artifact_slug": "demo", "version": "0.1.0"})
    req := httptest.NewRequest("POST", "/v1/install", bytestest.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code != 200 {
        t.Fatalf("status %d body %s", w.Code, w.Body.String())
    }
    if _, err := os.Stat(filepath.Join(skillsRoot, "demo", "SKILL.md")); err != nil {
        t.Fatalf("expected installed file: %v", err)
    }

    // Re-install to verify backup
    req2 := httptest.NewRequest("POST", "/v1/install", bytestest.NewReader(body))
    req2.Header.Set("Authorization", "Bearer tok")
    w2 := httptest.NewRecorder()
    h.ServeHTTP(w2, req2)
    if w2.Code != 200 {
        t.Fatalf("reinstall status %d", w2.Code)
    }
    backups, _ := os.ReadDir(filepath.Join(skillsRoot, ".claude-hub-backup"))
    if len(backups) != 1 {
        t.Fatalf("expected 1 backup, got %d", len(backups))
    }
}

func TestInstall_ShaMismatchPreservesTarget(t *testing.T) {
    bytesGz, _ := makeSampleTarGz(t)
    blob := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _, _ = w.Write(bytesGz)
    }))
    defer blob.Close()
    hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _ = json.NewEncoder(w).Encode(map[string]string{"downloadUrl": blob.URL, "sha256": "deadbeef" + hex.EncodeToString(make([]byte, 28))})
    }))
    defer hub.Close()

    skillsRoot := t.TempDir()
    j := jobs.New(hub.URL, "tok", skillsRoot)
    j.HTTPClient = hub.Client()

    h := local.InstallHandler(j, hub.URL, hub.Client(), "tok", skillsRoot)
    body, _ := json.Marshal(map[string]string{"artifact_slug": "demo", "version": "0.1.0"})
    req := httptest.NewRequest("POST", "/v1/install", bytestest.NewReader(body))
    req.Header.Set("Authorization", "Bearer tok")
    w := httptest.NewRecorder()
    h.ServeHTTP(w, req)
    if w.Code == 200 {
        t.Fatal("expected install to fail on sha mismatch")
    }
    if _, err := os.Stat(filepath.Join(skillsRoot, "demo")); !os.IsNotExist(err) {
        t.Fatal("expected target dir untouched on mismatch")
    }
}
```

- [ ] **Step 2: Run test to verify it fails (or passes after Tasks 25, 28 are merged)**

Run: `cd apps/agent && go test ./test/integration/...`
Expected: PASS once install handler + jobs.Install are merged.

- [ ] **Step 3: Fix any wiring issues**

Patch upstream tasks until all assertions pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./test/integration/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/test/integration/install_test.go
git commit -m "test(agent): add local /v1/install integration test with backup and sha mismatch"
```

---

### Task 42: E2E — Playwright multi-context publish then install

**Files:**
- Create: `e2e/publish-install.spec.ts`
- Create: `e2e/fixtures/spawn-agent.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from '@playwright/test';
import { spawnAgent } from './fixtures/spawn-agent';

test('publish on Alice then install on Bob', async ({ browser }) => {
  const aliceAgent = await spawnAgent({ user: 'alice@example.com', skills: ['demo'] });
  const bobAgent = await spawnAgent({ user: 'bob@example.com', skills: [] });

  const aliceCtx = await browser.newContext({ storageState: aliceAgent.storage });
  const aliceP = await aliceCtx.newPage();
  await aliceP.goto('http://localhost:3000/local');
  await expect(aliceP.getByText('demo')).toBeVisible();
  await aliceP.getByRole('button', { name: /publish/i }).click();
  await aliceP.getByLabel('Description').fill('Demo skill');
  await aliceP.getByRole('button', { name: /^publish$/i }).click();

  await aliceP.goto('http://localhost:3000/catalog');
  await expect(aliceP.getByText('demo', { exact: true })).toBeVisible({ timeout: 5000 });

  const bobCtx = await browser.newContext({ storageState: bobAgent.storage });
  const bobP = await bobCtx.newPage();
  await bobP.goto('http://localhost:3000/catalog/demo');
  await bobP.getByRole('button', { name: /install/i }).click();
  await expect(bobP.getByText(/installed/i)).toBeVisible({ timeout: 10_000 });

  await bobP.goto('http://localhost:3000/local');
  await expect(bobP.getByText('demo')).toBeVisible({ timeout: 5000 });

  expect(await bobAgent.fileExists('.claude/skills/demo/SKILL.md')).toBe(true);

  await aliceCtx.close();
  await bobCtx.close();
  await aliceAgent.stop();
  await bobAgent.stop();
});
```

`e2e/fixtures/spawn-agent.ts`:
```ts
// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function spawnAgent(opts: { user: string; skills: string[] }) {
  const home = mkdtempSync(join(tmpdir(), 'hub-agent-'));
  const skillsDir = join(home, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const s of opts.skills) {
    mkdirSync(join(skillsDir, s));
    writeFileSync(join(skillsDir, s, 'SKILL.md'), `---\nname: ${s}\ndescription: d\n---\n`);
  }
  // Pair user, capture cookie via REST helper, spawn agent binary
  const proc: ChildProcess = spawn('apps/agent/bin/claude-hub-agent', ['run'], {
    env: { ...process.env, CLAUDE_HOME: join(home, '.claude') },
  });
  // wait until /v1/status responds
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:7878/v1/status');
      if (r.ok) break;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  return {
    storage: { cookies: [], origins: [] },
    fileExists: (rel: string) => existsSync(join(home, rel)),
    stop: () => { proc.kill(); },
  };
}
```

- [ ] **Step 2: Run test to verify it fails (until full stack is wired up)**

Run: `pnpm --filter e2e exec playwright test publish-install`
Expected: FAIL until all upstream tasks are complete and `apps/agent/bin/claude-hub-agent` is built.

- [ ] **Step 3: Build daemon and run docker-compose stack before test**

Add to `e2e/global-setup.ts`:
```ts
// SPDX-License-Identifier: Apache-2.0
import { execa } from 'execa';

export default async function globalSetup() {
  await execa('go', ['build', '-o', 'bin/claude-hub-agent', './cmd/agent'], { cwd: 'apps/agent' });
  await execa('docker', ['compose', '-f', 'ops/docker/docker-compose.yml', 'up', '-d']);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter e2e exec playwright test publish-install`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add e2e/publish-install.spec.ts e2e/fixtures/spawn-agent.ts e2e/global-setup.ts
git commit -m "test(e2e): add publish-install round-trip Playwright test"
```

---

## Sekce K — Polish & wire-up

### Task 43: Wire MinIO + WSS gateway into server bootstrap

**Files:**
- Modify: `apps/hub-server/src/main.ts`
- Test: `apps/hub-server/test/integration/bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/test-server';

describe('server bootstrap', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); }, 90_000);
  afterAll(async () => { await srv.stop(); });

  it('responds to /healthz with 200', async () => {
    const r = await fetch(`${srv.url}/healthz`);
    expect(r.status).toBe(200);
  });

  it('responds to /readyz with DB + MinIO healthy', async () => {
    const r = await fetch(`${srv.url}/readyz`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.db).toBe('ok');
    expect(body.minio).toBe('ok');
  });

  it('exposes /api/artifacts behind auth', async () => {
    const r = await fetch(`${srv.url}/api/artifacts`);
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter hub-server vitest run test/integration/bootstrap.test.ts`
Expected: FAIL — `/readyz` may not check MinIO; `/api/artifacts` may 404 before mount.

- [ ] **Step 3: Wire bootstrap**

```ts
// SPDX-License-Identifier: Apache-2.0
// apps/hub-server/src/main.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { runMigrations } from './db/migrate';
import { bootstrapBucket, s3 } from './storage/minio';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { db } from './db';
import { artifactsRouter } from './routes';
import { publishRequestRoute } from './routes/local/publish-request';
import { installRequestRoute } from './routes/local/install-request';
import { authRouter } from './routes/auth';
import { daemonsRouter } from './routes/daemons';
import { attachWsUpgrade } from './ws/upgrade';
import { env } from './config/env';

export async function bootServer(port: number = parseInt(env.HUB_BIND_ADDR.split(':')[1] ?? '3000', 10)) {
  await runMigrations(env.DATABASE_URL);
  await bootstrapBucket();

  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    let dbOk = 'ok';
    let minioOk = 'ok';
    try { await db.execute('SELECT 1'); } catch { dbOk = 'fail'; }
    try { await s3.send(new HeadBucketCommand({ Bucket: env.MINIO_BUCKET })); } catch { minioOk = 'fail'; }
    return c.json({ db: dbOk, minio: minioOk }, dbOk === 'ok' && minioOk === 'ok' ? 200 : 503);
  });
  app.route('/api/auth', authRouter);
  app.route('/api/daemons', daemonsRouter);
  app.route('/api/artifacts', artifactsRouter);
  app.route('/api/local', publishRequestRoute);
  app.route('/api', installRequestRoute);

  const server = serve({ fetch: app.fetch, port });
  attachWsUpgrade(server);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void bootServer();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter hub-server vitest run test/integration/bootstrap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/main.ts apps/hub-server/test/integration/bootstrap.test.ts
git commit -m "chore(server): wire artifact catalog and MinIO into main bootstrap"
```

---

### Task 44: Wire scanner registry + watcher + jobs into daemon bootstrap

**Files:**
- Modify: `apps/agent/cmd/agent/main.go`
- Test: `apps/agent/test/integration/bootstrap_test.go`

- [ ] **Step 1: Write the failing test**

```go
// SPDX-License-Identifier: Apache-2.0
package integration

import (
    "encoding/json"
    "net/http"
    "os"
    "path/filepath"
    "testing"
    "time"

    agent "claude-hub/agent/cmd/agent"
)

func TestBootstrap_ServesStatus(t *testing.T) {
    home := t.TempDir()
    if err := os.MkdirAll(filepath.Join(home, ".claude", "skills"), 0o755); err != nil {
        t.Fatal(err)
    }
    cfg := agent.Config{
        ClaudeHome:  filepath.Join(home, ".claude"),
        BindAddr:    "127.0.0.1:0",
        AgentToken:  "tok",
    }
    srv, addr, err := agent.StartForTest(cfg)
    if err != nil {
        t.Fatalf("start: %v", err)
    }
    defer srv.Close()

    // Wait briefly for boot
    deadline := time.Now().Add(2 * time.Second)
    var resp *http.Response
    for time.Now().Before(deadline) {
        r, err := http.Get("http://" + addr + "/v1/status")
        if err == nil {
            resp = r
            break
        }
        time.Sleep(50 * time.Millisecond)
    }
    if resp == nil {
        t.Fatal("status endpoint never responded")
    }
    defer resp.Body.Close()
    var body map[string]any
    if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
        t.Fatal(err)
    }
    if body["agent_version"] == nil {
        t.Fatalf("expected agent_version in status: %+v", body)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && go test ./test/integration/...`
Expected: FAIL — `agent.StartForTest` and `agent.Config` may not exist yet

- [ ] **Step 3: Wire bootstrap**

```go
// SPDX-License-Identifier: Apache-2.0
// apps/agent/cmd/agent/main.go
package agent

import (
    "context"
    "encoding/json"
    "net"
    "net/http"
    "path/filepath"
    "time"

    "claude-hub/agent/internal/api/local"
    "claude-hub/agent/internal/jobs"
    "claude-hub/agent/internal/scanner"
)

const AgentVersion = "0.1.0"

type Config struct {
    ClaudeHome string
    BindAddr   string
    AgentToken string
    HubURL     string
    DeviceTok  string
}

func StartForTest(cfg Config) (*http.Server, string, error) {
    skillsRoot := filepath.Join(cfg.ClaudeHome, "skills")
    j := jobs.New(cfg.HubURL, cfg.DeviceTok, skillsRoot)
    reg := scanner.NewRegistry(scanner.SkillScanner{Root: skillsRoot})
    _ = reg

    mux := http.NewServeMux()
    mux.HandleFunc("/v1/status", func(w http.ResponseWriter, r *http.Request) {
        _ = json.NewEncoder(w).Encode(map[string]any{
            "paired":        cfg.DeviceTok != "",
            "hub_url":       cfg.HubURL,
            "agent_version": AgentVersion,
            "online":        cfg.DeviceTok != "",
        })
    })
    mux.Handle("/v1/publish", local.PublishHandler(j, cfg.AgentToken))
    mux.Handle("/v1/install", local.InstallHandler(j, cfg.HubURL, j.HTTPClient, cfg.AgentToken, skillsRoot))
    mux.Handle("/v1/uninstall", local.UninstallHandler(skillsRoot, cfg.AgentToken))
    mux.Handle("/v1/toggle", local.ToggleHandler(stubRegistry{}, cfg.AgentToken))

    ln, err := net.Listen("tcp", cfg.BindAddr)
    if err != nil {
        return nil, "", err
    }
    srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
    go func() { _ = srv.Serve(ln) }()
    return srv, ln.Addr().String(), nil
}

type stubRegistry struct{}

func (stubRegistry) FindByArtifactID(string) (string, bool) { return "", false }

func Run(ctx context.Context, cfg Config) error {
    srv, _, err := StartForTest(cfg)
    if err != nil {
        return err
    }
    <-ctx.Done()
    return srv.Shutdown(context.Background())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && go test ./test/integration/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/cmd/agent/main.go apps/agent/test/integration/bootstrap_test.go
git commit -m "chore(agent): wire scanners, jobs, and local API in main"
```

---

### Task 45: Update README with Plan 3 capabilities

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Skills publish/install" section to root README**

```markdown
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
```

- [ ] **Step 2: Run nothing — docs change**

Run: `pnpm prettier --check README.md`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document skill publish/install flow"
```

---

## Self-review

### Spec coverage check
- [x] Spec §5.1 Postgres schema → Tasks 1, 2 — `artifacts`, `artifact_versions`, `install_events` with FKs, indexes, GIN over manifest.
- [x] Spec §6.3 Publish from dashboard → Tasks 31, 34, 24, 6 — full Browser → Hub → Daemon → Hub → MinIO → Postgres → broadcast pipeline.
- [x] Spec §6.5 Install from dashboard → Tasks 32, 36, 25, 10 — full pipeline including sha256 re-verification.
- [x] Spec §7.6 Daemon hardening (path whitelist, refuse `..`) → Task 25 has dedicated path-traversal tests.
- [x] Spec §7.7 Artifact integrity (sha256 client + server) → Task 6 server-side recompute, Task 25 client-side recompute.
- [x] Contracts §REST API → all six artifact endpoints + two broker endpoints (Tasks 6–12, 31, 32) implemented and mounted (Task 13).
- [x] Contracts §WSS protocol → all 13 message types covered (Task 14): inventory.snapshot/delta, job.result, pong, job.install, job.uninstall, job.toggle, job.package, ping, subscribe.local, local.snapshot, local.delta, catalog.update.
- [x] `job.toggle` (not `job.enable`) — wire format follows contract.
- [x] Forward-compat signatures field on manifest schema (Task 5).
- [x] Generic `ArtifactType` everywhere; non-skill types return 400 in MVP, ready for Plan 4.

### Dependencies for Plan 4
Plan 4 inherits:
- `Scanner` interface and `Parser` interface (Tasks 19, 20).
- `manifest.ArtifactType` enum (`skill | plugin | command | agent`).
- `Jobs` struct with `Parsers map[ArtifactType]Parser` (Task 23).
- Complete WSS message protocol including `job.toggle` (Task 14).
- Generic `/api/artifacts/*` endpoints — only need to relax the `type !== 'skill'` MVP guard.
- Plan 4 adds: `PluginParser`, `PluginScanner`, `CommandParser`, `CommandScanner`, `AgentParser`, `AgentScanner`, plugin `settings.json` toggle handler, manifest variants in `typeMeta`.

### Type consistency check
- TS `ArtifactType = 'skill' | 'plugin' | 'command' | 'agent'` (shared-types) — matched by Go `manifest.ArtifactType` constants.
- Slug regex `[a-z0-9][a-z0-9-]{0,63}` — enforced server-side in Task 4 and matches contracts §Naming.
- Semver regex `^\d+\.\d+\.\d+$` — strict, no pre-release, per contracts §Naming.
- WSS message `id` is string everywhere; nanoid on hub side, time-based or UUID-v7 on daemon side both compatible.
- `requestId` in job payloads correlates request/response and matches Task 18 correlator.

### Placeholder scan
Searched all task code for placeholders (`TODO`, `...`, `<placeholder>`, `your-secret`). None remain in inline implementations or tests. Helper modules referenced from tests (`test-server`, `auth.ts`) are seeded by Plan 1 and extended only minimally in Tasks 38–41.

### Open questions resolved
- **Slug collisions** (spec §10.1): Task 6 enforces hub-wide unique slugs; second publish across users returns `409 slug_taken`.
- **`subscribe.local` authorization**: Task 16 stores `userId` per browser session; the `subscribe.local` handler (Task 17 / final wiring in Task 43) verifies the daemon belongs to the same user.
- **Backup retention**: Task 25 creates `.claude-hub-backup/<slug>-<timestamp>/` without GC. Documented as MVP follow-up; v1.1 adds retention policy.
- **Job timeout**: Task 18 uses 30s default; Task 32 install broker bumps to 120s for large blobs.
- **`targetPath` resolving `~`**: Task 32 sends literal `~/.claude/skills/<slug>`; daemon `Install` (Task 25) resolves via `os.UserHomeDir()` before path-traversal check.

### Risks
- **MinIO presigned URLs cross-host**: if the daemon runs outside Docker network, `http://minio:9000` is unreachable. Mitigation: configure MinIO with `PUBLIC_URL` derived from `env.PUBLIC_URL` so presigned URLs use the hub's externally reachable hostname. Task 43 wires this; verify in deployment docs.
- **fsnotify on Windows**: editor atomic-rename pattern can drop events. Task 21's debounce coalesces rapid changes; if Windows tests flake on CI matrix, fall back to 2s polling — defer until observed failure rather than preempting.
- **WSS reconnect race**: if the daemon reconnects mid-job, the hub's `pendingJobs` entry becomes stale. Task 18's 30-second timeout cleans up; Plan 4 adds explicit cleanup-on-disconnect in `Gateway.disconnectDaemon`.
- **JSON Schema drift Go ↔ TS**: Task 15 emits the schema once; CI should run the emit step and `git diff --exit-code` to catch silent drift. Add to GitHub Actions in Plan 1's CI workflow.
