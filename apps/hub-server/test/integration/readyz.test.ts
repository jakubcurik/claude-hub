// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createMinioClient } from '../../src/storage/minio.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';

describe('GET /readyz', () => {
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
    await pg.stop();
    await mn.stop();
  });

  it('returns ok when db and minio are reachable', async () => {
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ db: 'ok', minio: 'ok' });
  });
});
