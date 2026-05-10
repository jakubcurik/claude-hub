// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { invitations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { createSession } from '../auth/session.js';
import { setSessionCookie } from '../auth/cookie.js';
import { writeAudit } from '../audit.js';
import { toUserDTO } from './_user-dto.js';
import { requireUser, requireRole, type AuthEnv } from '../middleware/auth.js';

const RedeemSchema = z.object({
  password: z.string().min(12),
  name: z.string().min(1).max(120),
});

export function buildInvitationsRoutes(db: Db, opts: { secureCookie: boolean }) {
  const app = new Hono<AuthEnv>();

  app.get('/:token', async (c) => {
    const token = c.req.param('token');
    const row = (
      await db.select().from(invitations).where(eq(invitations.token, token)).limit(1)
    )[0];
    if (!row) {
      const err: ApiError = { code: 'not_found', message: 'Invitation not found' };
      return c.json(err, 404);
    }
    if (row.redeemedAt) {
      return c.json({ code: 'already_redeemed', message: 'Already redeemed' }, 409);
    }
    if (row.expiresAt.getTime() < Date.now()) {
      return c.json({ code: 'expired', message: 'Invitation expired' }, 410);
    }
    return c.json({
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
    });
  });

  app.post('/:token/redeem', async (c) => {
    const token = c.req.param('token');
    const parsed = RedeemSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = {
        code: 'validation_error',
        message: 'Invalid body',
        details: parsed.error.flatten(),
      };
      return c.json(err, 400);
    }

    const inv = (
      await db.select().from(invitations).where(eq(invitations.token, token)).limit(1)
    )[0];
    if (!inv) {
      const err: ApiError = { code: 'not_found', message: 'Invitation not found' };
      return c.json(err, 404);
    }
    if (inv.redeemedAt) {
      return c.json({ code: 'already_redeemed', message: 'Already redeemed' }, 409);
    }
    if (inv.expiresAt.getTime() < Date.now()) {
      return c.json({ code: 'expired', message: 'Invitation expired' }, 410);
    }
    if (!inv.email) {
      const err: ApiError = { code: 'validation_error', message: 'Invitation has no email' };
      return c.json(err, 400);
    }

    const existing = (await db.select().from(users).where(eq(users.email, inv.email)).limit(1))[0];
    if (existing) {
      const err: ApiError = { code: 'conflict', message: 'Email already registered' };
      return c.json(err, 409);
    }

    const userId = uuidv7();
    await db.insert(users).values({
      id: userId,
      email: inv.email,
      passwordHash: await hashPassword(parsed.data.password),
      name: parsed.data.name,
      role: inv.role,
    });
    await db
      .update(invitations)
      .set({ redeemedAt: new Date(), redeemedByUserId: userId })
      .where(eq(invitations.id, inv.id));
    await writeAudit(db, {
      actorUserId: userId,
      action: 'invitation.redeemed',
      targetType: 'invitation',
      targetId: inv.id,
    });

    const sessionToken = await createSession(db, userId);
    setSessionCookie(c, sessionToken, opts.secureCookie);

    const userRow = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]!;
    return c.json({ user: toUserDTO(userRow) }, 201);
  });

  app.delete('/:id', requireUser(db), requireRole('admin'), async (c) => {
    const id = c.req.param('id');
    await db.update(invitations).set({ expiresAt: new Date() }).where(eq(invitations.id, id));
    await writeAudit(db, {
      actorUserId: c.var.user.id,
      action: 'invitation.revoked',
      targetType: 'invitation',
      targetId: id,
    });
    return c.body(null, 204);
  });

  return app;
}
