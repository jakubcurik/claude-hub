// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/app.js';
import { users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('POST /api/daemons/pair', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;
  let aliceCookie: string;
  let aliceId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings, daemons CASCADE`);
    aliceId = uuidv7();
    const hash = await hashPassword('seed-password-1234');
    await pg.db
      .insert(users)
      .values([
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

  it('returns 6-digit pin and pairing id for logged-in user', async () => {
    const res = await app.request('/api/daemons/pair', {
      method: 'POST',
      headers: { cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pin).toMatch(/^\d{6}$/);
    expect(body.pairingId).toBeDefined();
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects unauthenticated', async () => {
    const res = await app.request('/api/daemons/pair', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
