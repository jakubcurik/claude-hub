// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { loginAs, seedArtifact } from '../helpers/auth.js';

describe('GET /api/artifacts/:slug/versions/:version', () => {
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
      slug: 'verd',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
  }, 180_000);

  afterAll(async () => {
    __resetMinioClientForTests();
    await mn.stop();
    await pg.stop();
  });

  it('returns version with embedded manifest', async () => {
    const r = await app.request('/api/artifacts/verd/versions/0.1.0', { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      version: string;
      manifest: { name: string };
      sha256: string;
    };
    expect(body.version).toBe('0.1.0');
    expect(body.manifest.name).toBe('verd');
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('404 on unknown version', async () => {
    const r = await app.request('/api/artifacts/verd/versions/9.9.9', { headers: { cookie } });
    expect(r.status).toBe(404);
  });
});
