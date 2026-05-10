// SPDX-License-Identifier: Apache-2.0
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import type { Db } from '../../src/db/client.js';

const SHARED_PASSWORD = 'seed-password-1234';

export async function loginAs(
  db: Db,
  email: string,
  opts: { role?: 'admin' | 'member'; name?: string } = {},
): Promise<string> {
  const role = opts.role ?? 'member';
  const name = opts.name ?? email.split('@')[0] ?? 'user';

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
  } else {
    userId = uuidv7();
    const hash = await hashPassword(SHARED_PASSWORD);
    await db.insert(users).values({ id: userId, email, passwordHash: hash, name, role });
  }
  const token = await createSession(db, userId);
  return `hub_session=${token}`;
}
