// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('setup wizard', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings CASCADE`);
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('creates the root admin when no users exist', async () => {
    const res = await app.request('/api/setup/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root@b.cz', password: 'rootpassword12', name: 'Root' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.role).toBe('admin');
  });

  it('returns 409 when users already exist', async () => {
    await app.request('/api/setup/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root@b.cz', password: 'rootpassword12', name: 'Root' }),
    });
    const res = await app.request('/api/setup/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root2@b.cz', password: 'rootpassword12', name: 'Root2' }),
    });
    expect(res.status).toBe(409);
  });

  it('GET /api/setup/status reports needsSetup', async () => {
    const res = await app.request('/api/setup/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsSetup: true });
  });
});
