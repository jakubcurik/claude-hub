// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { users } from '../db/schema.js';
import { createSession } from '../auth/session.js';
import { requireUser, requireRole, type AuthEnv } from './auth.js';
import { startPostgres, type PgFixture } from '../../test/helpers/postgres.js';

describe('auth middleware', () => {
  let pg: PgFixture;
  let memberId: string;
  let adminId: string;
  let memberToken: string;
  let adminToken: string;

  beforeAll(async () => {
    pg = await startPostgres();
    memberId = uuidv7();
    adminId = uuidv7();
    await pg.db.insert(users).values([
      { id: memberId, email: 'm@b.cz', passwordHash: 'x', name: 'M', role: 'member' },
      { id: adminId, email: 'a@b.cz', passwordHash: 'x', name: 'A', role: 'admin' },
    ]);
    memberToken = await createSession(pg.db, memberId);
    adminToken = await createSession(pg.db, adminId);
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  function buildTestApp() {
    const app = new Hono<AuthEnv>();
    app.use('*', requireUser(pg.db));
    app.get('/me', (c) => c.json({ userId: c.var.user.id, role: c.var.user.role }));
    app.get('/admin', requireRole('admin'), (c) => c.json({ ok: true }));
    return app;
  }

  it('rejects request without cookie', async () => {
    const res = await buildTestApp().request('/me');
    expect(res.status).toBe(401);
  });

  it('accepts valid session cookie', async () => {
    const res = await buildTestApp().request('/me', {
      headers: { cookie: `hub_session=${memberToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: memberId, role: 'member' });
  });

  it('member is forbidden from admin route', async () => {
    const res = await buildTestApp().request('/admin', {
      headers: { cookie: `hub_session=${memberToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('admin passes admin route', async () => {
    const res = await buildTestApp().request('/admin', {
      headers: { cookie: `hub_session=${adminToken}` },
    });
    expect(res.status).toBe(200);
  });
});
