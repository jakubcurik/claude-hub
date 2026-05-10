// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { invitations, users } from '../db/schema.js';
import { requireUser, requireRole, type AuthEnv } from '../middleware/auth.js';
import { writeAudit } from '../audit.js';
import { toUserDTO } from './_user-dto.js';

const InviteSchema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.toLowerCase().trim()),
  role: z.enum(['admin', 'member']).default('member'),
});
const PatchSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  active: z.boolean().optional(),
});

export function buildUsersRoutes(db: Db, opts: { publicUrl: string }) {
  const app = new Hono<AuthEnv>();
  app.use('*', requireUser(db));
  app.use('*', requireRole('admin'));

  app.get('/', async (c) => {
    const rows = await db.select().from(users);
    return c.json({ users: rows.map(toUserDTO) });
  });

  app.post('/invite', async (c) => {
    const parsed = InviteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = { code: 'validation_error', message: 'Invalid body' };
      return c.json(err, 400);
    }
    const id = uuidv7();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(invitations).values({
      id,
      token,
      email: parsed.data.email,
      role: parsed.data.role,
      invitedByUserId: c.var.user.id,
      expiresAt,
    });
    await writeAudit(db, {
      actorUserId: c.var.user.id,
      action: 'invitation.created',
      targetType: 'invitation',
      targetId: id,
      payload: { email: parsed.data.email, role: parsed.data.role },
    });
    const inviteUrl = `${opts.publicUrl}/register?token=${token}&email=${encodeURIComponent(parsed.data.email)}`;
    return c.json({ id, token, inviteUrl, expiresAt: expiresAt.toISOString() }, 201);
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = { code: 'validation_error', message: 'Invalid body' };
      return c.json(err, 400);
    }
    if (id === c.var.user.id) {
      if (parsed.data.role && parsed.data.role !== 'admin') {
        const err: ApiError = { code: 'validation_error', message: 'Cannot change own role' };
        return c.json(err, 400);
      }
      if (parsed.data.active === false) {
        const err: ApiError = { code: 'validation_error', message: 'Cannot deactivate self' };
        return c.json(err, 400);
      }
    }
    const update: Partial<typeof users.$inferInsert> = {};
    if (parsed.data.role) update.role = parsed.data.role;
    if (parsed.data.active !== undefined) update.active = parsed.data.active;
    await db.update(users).set(update).where(eq(users.id, id));
    const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!row) {
      const err: ApiError = { code: 'not_found', message: 'User not found' };
      return c.json(err, 404);
    }
    await writeAudit(db, {
      actorUserId: c.var.user.id,
      action: 'user.patch',
      targetType: 'user',
      targetId: id,
      payload: parsed.data as Record<string, unknown>,
    });
    return c.json({ user: toUserDTO(row) });
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (id === c.var.user.id) {
      const err: ApiError = { code: 'validation_error', message: 'Cannot deactivate self' };
      return c.json(err, 400);
    }
    await db.update(users).set({ active: false }).where(eq(users.id, id));
    await writeAudit(db, {
      actorUserId: c.var.user.id,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
    });
    return c.body(null, 204);
  });

  return app;
}
