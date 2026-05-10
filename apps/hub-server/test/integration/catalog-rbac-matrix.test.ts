// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { loginAs, seedArtifact, promoteToAdmin } from '../helpers/auth.js';

describe('catalog RBAC matrix', () => {
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

  it('member can yank own', async () => {
    const owner = await loginAs(pg.db, 'owner@example.com');
    await seedArtifact(app, owner, {
      slug: 'mine-y',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    const r = await app.request('/api/artifacts/mine-y/yank', {
      method: 'POST',
      headers: { cookie: owner },
    });
    expect(r.status).toBe(200);
  });

  it("member cannot yank another's artifact", async () => {
    const owner = await loginAs(pg.db, 'o5@example.com');
    await seedArtifact(app, owner, {
      slug: 'their-y',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    const other = await loginAs(pg.db, 'mem@example.com');
    const r = await app.request('/api/artifacts/their-y/yank', {
      method: 'POST',
      headers: { cookie: other },
    });
    expect(r.status).toBe(403);
  });

  it('member cannot DELETE artifact', async () => {
    const owner = await loginAs(pg.db, 'o6@example.com');
    await seedArtifact(app, owner, {
      slug: 'arc-mem',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    const r = await app.request('/api/artifacts/arc-mem', {
      method: 'DELETE',
      headers: { cookie: owner },
    });
    expect(r.status).toBe(403);
  });

  it('admin can DELETE', async () => {
    const owner = await loginAs(pg.db, 'o7@example.com');
    await seedArtifact(app, owner, {
      slug: 'arc-adm',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    await promoteToAdmin(pg.db, 'adm@example.com');
    const adm = await loginAs(pg.db, 'adm@example.com');
    const r = await app.request('/api/artifacts/arc-adm', {
      method: 'DELETE',
      headers: { cookie: adm },
    });
    expect(r.status).toBe(200);
  });

  it('member cannot upload non-skill type in MVP', async () => {
    const member = await loginAs(pg.db, 'mb@example.com');
    const form = new FormData();
    form.set('slug', 'plg');
    form.set('type', 'plugin');
    form.set('version', '0.1.0');
    form.set('description', 'd');
    form.set('sha256', 'a'.repeat(64));
    form.set(
      'manifest',
      JSON.stringify({
        schemaVersion: 1,
        name: 'plg',
        type: 'plugin',
        description: 'd',
        typeMeta: {},
      }),
    );
    form.set('file', new Blob([Buffer.from('x')], { type: 'application/gzip' }), 'a.tar.gz');
    const r = await app.request('/api/artifacts/upload', {
      method: 'POST',
      headers: { cookie: member },
      body: form,
    });
    expect(r.status).toBe(400);
  });
});
