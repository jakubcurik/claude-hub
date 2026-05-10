// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/app.js';
import { users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('admin users routes', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;
  let adminCookie: string;
  let memberCookie: string;
  let memberId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings CASCADE`);
    const adminId = uuidv7();
    memberId = uuidv7();
    const hash = await hashPassword('seed-password-1234');
    await pg.db.insert(users).values([
      { id: adminId, email: 'a@b.cz', passwordHash: hash, name: 'A', role: 'admin' },
      { id: memberId, email: 'm@b.cz', passwordHash: hash, name: 'M', role: 'member' },
    ]);
    adminCookie = `hub_session=${await createSession(pg.db, adminId)}`;
    memberCookie = `hub_session=${await createSession(pg.db, memberId)}`;
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('GET /api/users requires admin (member -> 403)', async () => {
    const res = await app.request('/api/users', { headers: { cookie: memberCookie } });
    expect(res.status).toBe(403);
  });

  it('GET /api/users returns list for admin', async () => {
    const res = await app.request('/api/users', { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(2);
  });

  it('POST /api/users/invite returns invite token', async () => {
    const res = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'invitee@b.cz' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.inviteUrl).toMatch(/\/register\?token=/);
  });

  it('PATCH /api/users/:id changes role', async () => {
    const res = await app.request(`/api/users/${memberId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.role).toBe('admin');
  });

  it('DELETE /api/users/:id deactivates the user', async () => {
    const res = await app.request(`/api/users/${memberId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(204);
  });

  it('PATCH /api/users/:id blocks admin self-demotion to member', async () => {
    const adminId = (await pg.db.select().from(users).where(eq(users.email, 'a@b.cz')).limit(1))[0]!
      .id;
    const res = await app.request(`/api/users/${adminId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/users/:id blocks admin self-deactivation', async () => {
    const adminId = (await pg.db.select().from(users).where(eq(users.email, 'a@b.cz')).limit(1))[0]!
      .id;
    const res = await app.request(`/api/users/${adminId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(400);
  });
});
