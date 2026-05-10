// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { users } from '../db/schema.js';
import { startPostgres, type PgFixture } from '../../test/helpers/postgres.js';
import { createSession, lookupSession, deleteSession, generateSessionToken } from './session.js';

describe('session', () => {
  let pg: PgFixture;
  let userId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    userId = uuidv7();
    await pg.db.insert(users).values({
      id: userId,
      email: 's@b.cz',
      passwordHash: 'x',
      name: 'S',
      role: 'member',
    });
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  it('generateSessionToken returns 256-bit base64url', () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(43);
  });

  it('creates and looks up a session', async () => {
    const token = await createSession(pg.db, userId);
    const row = await lookupSession(pg.db, token);
    expect(row?.userId).toBe(userId);
  });

  it('returns null for invalid token', async () => {
    expect(await lookupSession(pg.db, 'nonexistent')).toBeNull();
  });

  it('deleteSession invalidates token', async () => {
    const token = await createSession(pg.db, userId);
    await deleteSession(pg.db, token);
    expect(await lookupSession(pg.db, token)).toBeNull();
  });
});
