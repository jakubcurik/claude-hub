// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { users } from '../../src/db/schema.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('db integration', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  it('inserts and queries a user', async () => {
    const id = uuidv7();
    await pg.db.insert(users).values({
      id,
      email: 'a@b.cz',
      passwordHash: 'x',
      name: 'A',
      role: 'admin',
    });

    const rows = await pg.db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('a@b.cz');
  });
});
