// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.js';
import { pairings } from '../db/schema.js';
import { requireUser, type AuthEnv } from '../middleware/auth.js';

const PIN_TTL_MS = 5 * 60 * 1000;

function genPin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const a = buf[0] ?? 0;
  const b = buf[1] ?? 0;
  const c = buf[2] ?? 0;
  const d = buf[3] ?? 0;
  const n = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return (n % 1_000_000).toString().padStart(6, '0');
}

export function buildDaemonsRoutes(db: Db) {
  const app = new Hono<AuthEnv>();

  app.post('/pair', requireUser(db), async (c) => {
    const user = c.get('user');
    const id = uuidv7();
    const pin = genPin();
    const expiresAt = new Date(Date.now() + PIN_TTL_MS);
    await db.insert(pairings).values({ id, pin, userId: user.id, expiresAt });
    return c.json({ pairingId: id, pin, expiresAt: expiresAt.toISOString() });
  });

  return app;
}
