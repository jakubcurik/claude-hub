// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { users, pairings } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { sweepExpiredPairings } from '../../src/jobs/pairing-sweep.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('pairing sweep', () => {
  let pg: PgFixture;
  let aliceId: string;

  beforeAll(async () => {
    pg = await startPostgres();
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
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('deletes pairings whose expires_at is in the past', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    await pg.db.insert(pairings).values([
      { id: uuidv7(), pin: '999999', userId: aliceId, expiresAt: past },
      { id: uuidv7(), pin: '111111', userId: aliceId, expiresAt: future },
    ]);
    const removed = await sweepExpiredPairings(pg.db);
    expect(removed).toBe(1);
    const left = await pg.db.select({ c: sql<number>`count(*)` }).from(pairings);
    expect(Number(left[0]?.c ?? 0)).toBe(1);
  });

  it('returns 0 when no expired pairings', async () => {
    const future = new Date(Date.now() + 60_000);
    await pg.db
      .insert(pairings)
      .values({ id: uuidv7(), pin: '222222', userId: aliceId, expiresAt: future });
    const removed = await sweepExpiredPairings(pg.db);
    expect(removed).toBe(0);
  });
});
