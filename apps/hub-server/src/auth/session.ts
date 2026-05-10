// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = generateSessionToken();
  await db.insert(sessions).values({
    id: uuidv7(),
    userId,
    token,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export interface SessionRow {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

export async function lookupSession(db: Db, token: string): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}
