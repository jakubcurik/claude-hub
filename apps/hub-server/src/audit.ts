// SPDX-License-Identifier: Apache-2.0
import { v7 as uuidv7 } from 'uuid';
import type { Db } from './db/client.js';
import { auditLog } from './db/schema.js';

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    id: uuidv7(),
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    payload: entry.payload ?? null,
  });
}
