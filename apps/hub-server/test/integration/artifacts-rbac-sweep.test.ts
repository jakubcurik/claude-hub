// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('artifacts routes RBAC sweep', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  const endpoints = [
    { method: 'GET', path: '/api/artifacts' },
    { method: 'GET', path: '/api/artifacts/foo' },
    { method: 'POST', path: '/api/artifacts/upload' },
    { method: 'POST', path: '/api/artifacts/foo/yank' },
    { method: 'DELETE', path: '/api/artifacts/foo' },
    { method: 'GET', path: '/api/artifacts/foo/versions/0.1.0' },
    { method: 'GET', path: '/api/artifacts/foo/versions/0.1.0/download' },
  ] as const;

  it.each(endpoints)('returns 401 unauthenticated for $method $path', async ({ method, path }) => {
    const r = await app.request(path, { method });
    expect(r.status).toBe(401);
  });
});
