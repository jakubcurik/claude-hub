// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { loginAs, seedArtifact, promoteToAdmin } from '../helpers/auth.js';

describe('POST /api/artifacts/:slug/yank', () => {
  let pg: PgFixture;
  let mn: MinioFixture;
  let app: ReturnType<typeof buildApp>;

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
  }, 180_000);

  beforeEach(async () => {
    await pg.db.execute(
      sql`TRUNCATE users, sessions, audit_log, pairings, daemons, artifacts, artifact_versions, install_events CASCADE`,
    );
  });

  afterAll(async () => {
    __resetMinioClientForTests();
    await mn.stop();
    await pg.stop();
  });

  it('owner can yank own artifact', async () => {
    const ck = await loginAs(pg.db, 'owner@example.com');
    await seedArtifact(app, ck, {
      slug: 'mine',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    const r = await app.request('/api/artifacts/mine/yank', {
      method: 'POST',
      headers: { cookie: ck },
    });
    expect(r.status).toBe(200);

    const det = await app.request('/api/artifacts/mine', { headers: { cookie: ck } });
    const body = await det.json();
    expect(body.versions.every((v: { deprecated: boolean }) => v.deprecated)).toBe(true);
  });

  it('non-owner member receives 403', async () => {
    const owner = await loginAs(pg.db, 'o2@example.com');
    await seedArtifact(app, owner, {
      slug: 'theirs',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    const other = await loginAs(pg.db, 'other@example.com');
    const r = await app.request('/api/artifacts/theirs/yank', {
      method: 'POST',
      headers: { cookie: other },
    });
    expect(r.status).toBe(403);
  });

  it('admin can yank any artifact', async () => {
    const owner = await loginAs(pg.db, 'o3@example.com');
    await seedArtifact(app, owner, {
      slug: 'admyank',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    await promoteToAdmin(pg.db, 'admin@example.com');
    const adm = await loginAs(pg.db, 'admin@example.com');
    const r = await app.request('/api/artifacts/admyank/yank', {
      method: 'POST',
      headers: { cookie: adm },
    });
    expect(r.status).toBe(200);
  });
});
