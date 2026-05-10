// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { loginAs, seedArtifact } from '../helpers/auth.js';

describe('publish round-trip', () => {
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
    await pg.db.execute(
      sql`TRUNCATE users, sessions, audit_log, pairings, daemons, artifacts, artifact_versions, install_events CASCADE`,
    );
  }, 180_000);

  afterAll(async () => {
    __resetMinioClientForTests();
    await mn.stop();
    await pg.stop();
  });

  it('uploads bytes and round-trips download with matching sha', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const fileBytes = Buffer.from('helper-archive-bytes-' + Math.random());
    const seeded = await seedArtifact(app, cookie, {
      slug: 'helper',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
      fileBytes,
    });
    const expectedSha = createHash('sha256').update(fileBytes).digest('hex');
    expect(seeded.sha256).toBe(expectedSha);

    const dl = await app.request('/api/artifacts/helper/versions/0.1.0/download', {
      headers: { cookie },
    });
    expect(dl.status).toBe(200);
    const meta = (await dl.json()) as { sha256: string; downloadUrl: string };
    expect(meta.sha256).toBe(expectedSha);

    const blobResp = await fetch(meta.downloadUrl);
    expect(blobResp.status).toBe(200);
    const buf = Buffer.from(await blobResp.arrayBuffer());
    expect(createHash('sha256').update(buf).digest('hex')).toBe(expectedSha);
    expect(buf.equals(fileBytes)).toBe(true);
  });
});
