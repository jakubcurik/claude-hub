// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/app.js';
import { users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('POST /api/daemons/register', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;
  let aliceCookie: string;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings, daemons CASCADE`);
    const aliceId = uuidv7();
    const hash = await hashPassword('seed-password-1234');
    await pg.db.insert(users).values([
      {
        id: aliceId,
        email: 'alice@example.com',
        passwordHash: hash,
        name: 'Alice',
        role: 'member',
      },
    ]);
    aliceCookie = `hub_session=${await createSession(pg.db, aliceId)}`;
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('exchanges valid pin for device_token', async () => {
    const pairRes = await app.request('/api/daemons/pair', {
      method: 'POST',
      headers: { cookie: aliceCookie },
    });
    const { pin } = await pairRes.json();

    const regRes = await app.request('/api/daemons/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin, hostname: 'mac-studio', os: 'macos', agentVersion: '0.1.0' }),
    });
    expect(regRes.status).toBe(200);
    const body = await regRes.json();
    expect(body.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.daemonId).toBeDefined();
  });

  it('rejects invalid pin', async () => {
    const res = await app.request('/api/daemons/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '000000', hostname: 'h', os: 'linux', agentVersion: '0.1.0' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects already-consumed pin', async () => {
    const pairRes = await app.request('/api/daemons/pair', {
      method: 'POST',
      headers: { cookie: aliceCookie },
    });
    const { pin } = await pairRes.json();
    const body = JSON.stringify({ pin, hostname: 'h', os: 'linux', agentVersion: '0.1.0' });
    const first = await app.request('/api/daemons/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request('/api/daemons/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(400);
  });
});
