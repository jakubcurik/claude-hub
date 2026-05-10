// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { loginAs, seedArtifact, yankArtifactVersions } from '../helpers/auth.js';

describe('GET /api/artifacts/:slug', () => {
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
      slug: 'multi',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    // tiny delay so publishedAt timestamps differ enough for desc ordering
    await new Promise((r) => setTimeout(r, 25));
    await seedArtifact(app, cookie, {
      slug: 'multi',
      type: 'skill',
      description: 'd',
      version: '0.2.0',
    });
    await yankArtifactVersions(pg.db, 'multi', ['0.1.0']);
  }, 180_000);

  afterAll(async () => {
    __resetMinioClientForTests();
    await mn.stop();
    await pg.stop();
  });

  it('404 on unknown slug', async () => {
    const r = await app.request('/api/artifacts/missing', { headers: { cookie } });
    expect(r.status).toBe(404);
  });

  it('returns artifact + versions sorted desc by publishedAt', async () => {
    const r = await app.request('/api/artifacts/multi', { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      artifact: { slug: string };
      versions: { version: string; deprecated: boolean }[];
    };
    expect(body.artifact.slug).toBe('multi');
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0]?.version).toBe('0.2.0');
    expect(body.versions[1]?.deprecated).toBe(true);
  });
});
