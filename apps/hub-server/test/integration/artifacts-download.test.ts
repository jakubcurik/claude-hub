// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { loginAs, seedArtifact } from '../helpers/auth.js';

describe('GET /api/artifacts/:slug/versions/:version/download', () => {
  let pg: PgFixture;
  let mn: MinioFixture;
  let app: ReturnType<typeof buildApp>;
  let cookie: string;
  let expectedSha: string;
  const fileBytes = Buffer.from('hello-download-bytes');

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
    const seeded = await seedArtifact(app, cookie, {
      slug: 'dl',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
      fileBytes,
    });
    expectedSha = seeded.sha256;
  }, 180_000);

  afterAll(async () => {
    __resetMinioClientForTests();
    await mn.stop();
    await pg.stop();
  });

  it('returns presigned URL + sha256', async () => {
    const r = await app.request('/api/artifacts/dl/versions/0.1.0/download', {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { downloadUrl: string; sha256: string };
    expect(body.sha256).toBe(expectedSha);
    expect(body.downloadUrl).toMatch(/X-Amz-Signature=/);

    const fileResp = await fetch(body.downloadUrl);
    const buf = Buffer.from(await fileResp.arrayBuffer());
    expect(createHash('sha256').update(buf).digest('hex')).toBe(expectedSha);
  });

  it('404 on unknown', async () => {
    const r = await app.request('/api/artifacts/dl/versions/9.9.9/download', {
      headers: { cookie },
    });
    expect(r.status).toBe(404);
  });
});
