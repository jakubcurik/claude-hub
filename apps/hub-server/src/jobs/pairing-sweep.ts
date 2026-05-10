// SPDX-License-Identifier: Apache-2.0
import { lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pairings } from '../db/schema.js';

export async function sweepExpiredPairings(db: Db): Promise<number> {
  const now = new Date();
  const removed = await db
    .delete(pairings)
    .where(lt(pairings.expiresAt, now))
    .returning({ id: pairings.id });
  return removed.length;
}

export function startPairingSweep(db: Db, intervalMs = 60_000): () => void {
  const t = setInterval(() => {
    sweepExpiredPairings(db).catch((err) => {
      console.error('pairing-sweep error:', err);
    });
  }, intervalMs);
  if (typeof t.unref === 'function') t.unref();
  return () => clearInterval(t);
}
