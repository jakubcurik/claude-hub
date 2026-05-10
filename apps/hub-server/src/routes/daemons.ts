// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.js';
import { daemons, pairings } from '../db/schema.js';
import { requireUser, type AuthEnv } from '../middleware/auth.js';

const PIN_TTL_MS = 5 * 60 * 1000;

interface RegisterBody {
  pin?: string;
  hostname?: string;
  os?: 'windows' | 'macos' | 'linux';
  agentVersion?: string;
}

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

  app.post('/register', async (c) => {
    const parsed = (await c.req.json().catch(() => ({}))) as RegisterBody;
    const { pin, hostname, os, agentVersion } = parsed;
    if (!pin || !hostname || !os || !agentVersion) {
      return c.json({ error: 'missing_fields' }, 400);
    }
    if (!['windows', 'macos', 'linux'].includes(os)) {
      return c.json({ error: 'bad_os' }, 400);
    }

    const now = new Date();
    const [pairing] = await db
      .select()
      .from(pairings)
      .where(and(eq(pairings.pin, pin), isNull(pairings.consumedAt), gt(pairings.expiresAt, now)))
      .limit(1);
    if (!pairing) return c.json({ error: 'invalid_pin' }, 400);

    const tokenRaw = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(tokenRaw).digest('hex');
    const daemonId = uuidv7();

    await db.transaction(async (tx) => {
      await tx.insert(daemons).values({
        id: daemonId,
        userId: pairing.userId,
        hostname,
        os,
        agentVersion,
        tokenHash,
      });
      await tx.update(pairings).set({ consumedAt: now }).where(eq(pairings.id, pairing.id));
    });

    return c.json({ daemonId, deviceToken: tokenRaw });
  });

  return app;
}
