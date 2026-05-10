// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createMinioClient } from '../../src/storage/minio.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('server bootstrap', () => {
  let pg: PgFixture;
  let mn: MinioFixture;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startPostgres();
    mn = await startMinio();
    const minio = createMinioClient({
      endpoint: mn.endpoint,
      accessKey: mn.accessKey,
      secretKey: mn.secretKey,
      bucket: 'claude-hub-artifacts',
    });
    app = buildApp({ db: pg.db, minio });
  }, 180_000);

  afterAll(async () => {
    await mn.stop();
    await pg.stop();
  });

  it('responds to /healthz with 200', async () => {
    const r = await app.request('/healthz');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('responds to /readyz with DB + MinIO healthy', async () => {
    const r = await app.request('/readyz');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { db: string; minio: string };
    expect(body.db).toBe('ok');
    expect(body.minio).toBe('ok');
  });

  it('exposes /api/artifacts behind auth', async () => {
    const r = await app.request('/api/artifacts');
    expect(r.status).toBe(401);
  });
});
