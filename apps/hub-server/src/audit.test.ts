// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { users, auditLog } from './db/schema.js';
import { startPostgres, type PgFixture } from '../test/helpers/postgres.js';
import { writeAudit } from './audit.js';

describe('audit', () => {
  let pg: PgFixture;
  let userId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    userId = uuidv7();
    await pg.db.insert(users).values({
      id: userId,
      email: 'au@b.cz',
      passwordHash: 'x',
      name: 'A',
      role: 'admin',
    });
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  it('writes an audit row with payload', async () => {
    await writeAudit(pg.db, {
      actorUserId: userId,
      action: 'user.login',
      targetType: 'user',
      targetId: userId,
      payload: { ip: '127.0.0.1' },
    });

    const rows = await pg.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('user.login');
    expect(rows[0]?.payload).toEqual({ ip: '127.0.0.1' });
  });
});
