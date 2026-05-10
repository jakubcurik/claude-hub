// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { loginAs, seedArtifact, promoteToAdmin } from '../helpers/auth.js';

describe('DELETE /api/artifacts/:slug', () => {
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

  it('member receives 403', async () => {
    const owner = await loginAs(pg.db, 'a@example.com');
    await seedArtifact(app, owner, {
      slug: 'memarc',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    const r = await app.request('/api/artifacts/memarc', {
      method: 'DELETE',
      headers: { cookie: owner },
    });
    expect(r.status).toBe(403);
  });

  it('admin can archive; archived rows excluded from list', async () => {
    const owner = await loginAs(pg.db, 'b@example.com');
    await seedArtifact(app, owner, {
      slug: 'admarc',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    await promoteToAdmin(pg.db, 'admin2@example.com');
    const adm = await loginAs(pg.db, 'admin2@example.com');
    const r = await app.request('/api/artifacts/admarc', {
      method: 'DELETE',
      headers: { cookie: adm },
    });
    expect(r.status).toBe(200);

    const list = await app.request('/api/artifacts', { headers: { cookie: adm } });
    const body = (await list.json()) as { items: Array<{ slug: string }> };
    expect(body.items.find((i) => i.slug === 'admarc')).toBeUndefined();
  });
});
