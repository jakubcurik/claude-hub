// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { defaultLoginLimiter } from '../../src/middleware/rate-limit.js';
import { v7 as uuidv7 } from 'uuid';

describe('auth routes', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings CASCADE`);
    defaultLoginLimiter.reset('unknown', 'seed@b.cz');
    defaultLoginLimiter.reset('unknown', 'wrong@b.cz');
    await pg.db.insert(users).values({
      id: uuidv7(),
      email: 'seed@b.cz',
      passwordHash: await hashPassword('seed-password-1234'),
      name: 'Seed',
      role: 'admin',
    });
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('POST /api/auth/register creates a member user', async () => {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@b.cz', password: 'longpassword12', name: 'New' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.role).toBe('member');
    expect(body.user.email).toBe('new@b.cz');
  });

  it('POST /api/auth/login returns 200 + session cookie', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seed@b.cz', password: 'seed-password-1234' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/hub_session=/);
  });

  it('POST /api/auth/login wrong password returns 401', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seed@b.cz', password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me returns current user when authed', async () => {
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seed@b.cz', password: 'seed-password-1234' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const res = await app.request('/api/auth/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe('seed@b.cz');
  });

  it('POST /api/auth/logout invalidates session', async () => {
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seed@b.cz', password: 'seed-password-1234' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    const res = await app.request('/api/auth/me', { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/login 6th attempt returns 429', async () => {
    for (let i = 0; i < 5; i++) {
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'seed@b.cz', password: 'wrong' }),
      });
    }
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seed@b.cz', password: 'wrong' }),
    });
    expect(res.status).toBe(429);
  });

  it('POST /api/auth/register duplicate email returns 409', async () => {
    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dup@b.cz', password: 'longpassword12', name: 'A' }),
    });
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dup@b.cz', password: 'longpassword12', name: 'B' }),
    });
    expect(res.status).toBe(409);
  });

  it('POST /api/auth/register short password returns 400', async () => {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'short@b.cz', password: 'short', name: 'S' }),
    });
    expect(res.status).toBe(400);
  });
});
