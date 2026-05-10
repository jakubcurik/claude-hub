// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/app.js';
import { invitations, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('invitation routes', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;
  let adminCookie: string;
  let adminId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings, invitations CASCADE`);
    adminId = uuidv7();
    const hash = await hashPassword('seed-password-1234');
    await pg.db.insert(users).values({
      id: adminId,
      email: 'admin@b.cz',
      passwordHash: hash,
      name: 'Admin',
      role: 'admin',
    });
    adminCookie = `hub_session=${await createSession(pg.db, adminId)}`;
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('admin creates invite via /api/users/invite returning token', async () => {
    const res = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'invitee@b.cz', role: 'member' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.inviteUrl).toMatch(/\/register\?token=/);
    expect(body.expiresAt).toBeTruthy();
  });

  it('GET /api/invitations/:token returns email/role/expiresAt', async () => {
    const create = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'preview@b.cz', role: 'member' }),
    });
    const { token } = await create.json();

    const res = await app.request(`/api/invitations/${token}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe('preview@b.cz');
    expect(body.role).toBe('member');
    expect(body.expiresAt).toBeTruthy();
  });

  it('GET /api/invitations/:token returns 404 for unknown token', async () => {
    const res = await app.request('/api/invitations/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('POST /api/invitations/:token/redeem creates user, sets session', async () => {
    const create = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'redeem@b.cz', role: 'member' }),
    });
    const { token } = await create.json();

    const res = await app.request(`/api/invitations/${token}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'longpassword12', name: 'Redeemed' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.email).toBe('redeem@b.cz');
    expect(body.user.role).toBe('member');
    expect(res.headers.get('set-cookie')).toMatch(/hub_session=/);

    const u = (await pg.db.select().from(users).where(eq(users.email, 'redeem@b.cz')).limit(1))[0];
    expect(u).toBeTruthy();
    expect(u?.name).toBe('Redeemed');
  });

  it('second redeem of same token returns 409 already_redeemed', async () => {
    const create = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'twice@b.cz', role: 'member' }),
    });
    const { token } = await create.json();

    const first = await app.request(`/api/invitations/${token}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'longpassword12', name: 'First' }),
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/api/invitations/${token}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'longpassword12', name: 'Second' }),
    });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe('already_redeemed');
  });

  it('DELETE /api/invitations/:id by admin revokes invitation', async () => {
    const create = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'revoke@b.cz', role: 'member' }),
    });
    const { id, token } = await create.json();

    const del = await app.request(`/api/invitations/${id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(del.status).toBe(204);

    const get = await app.request(`/api/invitations/${token}`);
    expect([404, 410]).toContain(get.status);

    const row = (await pg.db.select().from(invitations).where(eq(invitations.id, id)).limit(1))[0];
    expect(row).toBeTruthy();
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('DELETE /api/invitations/:id requires admin', async () => {
    const memberId = uuidv7();
    await pg.db.insert(users).values({
      id: memberId,
      email: 'member@b.cz',
      passwordHash: await hashPassword('seed-password-1234'),
      name: 'Member',
      role: 'member',
    });
    const memberCookie = `hub_session=${await createSession(pg.db, memberId)}`;

    const create = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'forbid@b.cz', role: 'member' }),
    });
    const { id } = await create.json();

    const res = await app.request(`/api/invitations/${id}`, {
      method: 'DELETE',
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(403);
  });

  it('redeem with short password returns 400', async () => {
    const create = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'shortpw@b.cz', role: 'member' }),
    });
    const { token } = await create.json();

    const res = await app.request(`/api/invitations/${token}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'short', name: 'X' }),
    });
    expect(res.status).toBe(400);
  });
});
