// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/app.js';
import { users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

async function pairAndRegister(
  app: ReturnType<typeof buildApp>,
  cookie: string,
  fields: { hostname: string; os: 'windows' | 'macos' | 'linux'; agentVersion?: string },
): Promise<{ daemonId: string; deviceToken: string }> {
  const pairRes = await app.request('/api/daemons/pair', { method: 'POST', headers: { cookie } });
  const { pin } = await pairRes.json();
  const regRes = await app.request('/api/daemons/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin, agentVersion: '0.1.0', ...fields }),
  });
  return regRes.json();
}

describe('daemons list/delete', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;
  let aliceCookie: string;
  let bobCookie: string;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings, daemons CASCADE`);
    const aliceId = uuidv7();
    const bobId = uuidv7();
    const hash = await hashPassword('seed-password-1234');
    await pg.db.insert(users).values([
      {
        id: aliceId,
        email: 'alice@example.com',
        passwordHash: hash,
        name: 'Alice',
        role: 'member',
      },
      { id: bobId, email: 'bob@example.com', passwordHash: hash, name: 'Bob', role: 'member' },
    ]);
    aliceCookie = `hub_session=${await createSession(pg.db, aliceId)}`;
    bobCookie = `hub_session=${await createSession(pg.db, bobId)}`;
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('lists own daemons with online=false initially', async () => {
    await pairAndRegister(app, aliceCookie, { hostname: 'mac-studio', os: 'macos' });
    const res = await app.request('/api/daemons', { headers: { cookie: aliceCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daemons).toHaveLength(1);
    expect(body.daemons[0].hostname).toBe('mac-studio');
    expect(body.daemons[0].online).toBe(false);
  });

  it('does not leak daemons of other users', async () => {
    await pairAndRegister(app, aliceCookie, { hostname: 'mac', os: 'macos' });
    const res = await app.request('/api/daemons', { headers: { cookie: bobCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daemons).toHaveLength(0);
  });

  it("deletes own daemon, 404 for someone else's", async () => {
    const { daemonId } = await pairAndRegister(app, aliceCookie, { hostname: 'h', os: 'linux' });
    const denied = await app.request(`/api/daemons/${daemonId}`, {
      method: 'DELETE',
      headers: { cookie: bobCookie },
    });
    expect(denied.status).toBe(404);
    const ok = await app.request(`/api/daemons/${daemonId}`, {
      method: 'DELETE',
      headers: { cookie: aliceCookie },
    });
    expect(ok.status).toBe(204);
  });
});
