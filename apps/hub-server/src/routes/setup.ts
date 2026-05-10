// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { writeAudit } from '../audit.js';

const InitSchema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.toLowerCase().trim()),
  password: z.string().min(12),
  name: z.string().min(1).max(120),
});

async function userCount(db: Db): Promise<number> {
  const r = await db.execute<{ count: string }>(sql`select count(*)::text as count from users`);
  return Number.parseInt(r[0]?.count ?? '0', 10);
}

export function buildSetupRoutes(db: Db) {
  const app = new Hono();

  app.get('/status', async (c) => {
    return c.json({ needsSetup: (await userCount(db)) === 0 });
  });

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
    const createdAt = new Date();
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
    return c.json(
      {
        user: {
          id,
          email: parsed.data.email,
          name: parsed.data.name,
          role: 'admin' as const,
          createdAt: createdAt.toISOString(),
          lastLoginAt: null,
        },
      },
      201,
    );
  });

  return app;
}
