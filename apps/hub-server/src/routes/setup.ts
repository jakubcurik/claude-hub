// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { writeAudit } from '../audit.js';
import { toUserDTO } from './_user-dto.js';

const InitSchema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.toLowerCase().trim()),
  password: z.string().min(12),
  name: z.string().min(1).max(120),
});

async function userCount(db: Db): Promise<number> {
  const r = await db.execute<{ count: number }>(sql`select count(*)::int as count from users`);
  return r[0]?.count ?? 0;
}

export function buildSetupRoutes(db: Db) {
  const app = new Hono();

  app.get('/status', async (c) => {
    return c.json({ needsSetup: (await userCount(db)) === 0 });
  });

  // First-run bootstrap. The check-then-insert is not race-safe under
  // concurrent requests (two simultaneous /init calls with different
  // emails could both create admins), but for a first-run wizard at
  // single-tenant deployment scale this is acceptable. If hardening is
  // needed, wrap in a transaction with `pg_advisory_xact_lock(<key>)`.
  app.post('/init', async (c) => {
    if ((await userCount(db)) > 0) {
      const err: ApiError = { code: 'conflict', message: 'Setup already completed' };
      return c.json(err, 409);
    }
    const parsed = InitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = {
        code: 'validation_error',
        message: 'Invalid body',
        details: parsed.error.flatten(),
      };
      return c.json(err, 400);
    }
    const id = uuidv7();
    await db.insert(users).values({
      id,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      name: parsed.data.name,
      role: 'admin',
    });
    await writeAudit(db, {
      actorUserId: id,
      action: 'setup.init',
      targetType: 'user',
      targetId: id,
    });
    const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!;
    return c.json({ user: toUserDTO(row) }, 201);
  });

  return app;
}
