// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/app.js';
import { artifacts, artifactVersions, users } from '../../src/db/schema.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { loginAs, seedArtifact } from '../helpers/auth.js';

describe('GET /api/artifacts', () => {
  let pg: PgFixture;
  let mn: MinioFixture;
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeAll(async () => {
    pg = await startPostgres();
    mn = await startMinio();
    process.env.MINIO_ENDPOINT = mn.endpoint;
    process.env.MINIO_ACCESS_KEY = mn.accessKey;
    process.env.MINIO_SECRET_KEY = mn.secretKey;
    process.env.MINIO_BUCKET = 'claude-hub-artifacts';
    __resetMinioClientForTests();
    await bootstrapBucket();
    app = buildApp({ db: pg.db });

    await pg.db.execute(
      sql`TRUNCATE users, sessions, audit_log, pairings, daemons, artifacts, artifact_versions, install_events CASCADE`,
    );
    cookie = await loginAs(pg.db, 'alice@example.com');

    await seedArtifact(app, cookie, {
      slug: 'helper-a',
      type: 'skill',
      description: 'helper one',
      version: '0.1.0',
    });
    await seedArtifact(app, cookie, {
      slug: 'helper-b',
      type: 'skill',
      description: 'another helper',
      version: '0.1.0',
    });

    const aliceRows = await pg.db
      .select()
      .from(users)
      .where(eq(users.email, 'alice@example.com'))
      .limit(1);
    const aliceId = aliceRows[0]!.id;
    const pluginId = uuidv7();
    await pg.db.insert(artifacts).values({
      id: pluginId,
      slug: 'plug-a',
      type: 'plugin',
      description: 'plugin one',
      ownerUserId: aliceId,
    });
    await pg.db.insert(artifactVersions).values({
      id: uuidv7(),
      artifactId: pluginId,
      version: '0.1.0',
      storageKey: `artifacts/${pluginId}/0.1.0.tar.gz`,
      sha256: 'a'.repeat(64),
      manifest: {
        schemaVersion: 1,
        name: 'plug-a',
        type: 'plugin',
        description: 'plugin one',
        typeMeta: {},
      },
      publishedByUserId: aliceId,
    });
  }, 180_000);

  afterAll(async () => {
    __resetMinioClientForTests();
    await mn.stop();
    await pg.stop();
  });

  it('rejects unauthenticated', async () => {
    const r = await app.request('/api/artifacts');
    expect(r.status).toBe(401);
  });

  it('returns all non-archived artifacts by default', async () => {
    const r = await app.request('/api/artifacts', { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
  });

  it('filters by type', async () => {
    const r = await app.request('/api/artifacts?type=skill', { headers: { cookie } });
    const body = await r.json();
    expect(body.total).toBe(2);
    expect(body.items.every((i: { type: string }) => i.type === 'skill')).toBe(true);
  });

  it('filters by description ILIKE q', async () => {
    const r = await app.request('/api/artifacts?q=helper', { headers: { cookie } });
    const body = await r.json();
    expect(body.total).toBe(2);
  });

  it('paginates with limit and page', async () => {
    const r = await app.request('/api/artifacts?page=1&limit=1', { headers: { cookie } });
    const body = await r.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
  });
});
