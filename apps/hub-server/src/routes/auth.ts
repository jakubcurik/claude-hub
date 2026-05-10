// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { equalizeVerifyCost, hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/session.js';
import { setSessionCookie, clearSessionCookie, SESSION_COOKIE } from '../auth/cookie.js';
import { getCookie } from 'hono/cookie';
import { writeAudit } from '../audit.js';
import { defaultLoginLimiter } from '../middleware/rate-limit.js';
import { requireUser, type AuthEnv } from '../middleware/auth.js';
import { toUserDTO } from './_user-dto.js';

const RegisterSchema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.toLowerCase().trim()),
  password: z.string().min(12),
  name: z.string().min(1).max(120),
});

const LoginSchema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.toLowerCase().trim()),
  password: z.string(),
});

export function buildAuthRoutes(db: Db, opts: { secureCookie: boolean }) {
  const app = new Hono<AuthEnv>();

  app.post('/register', async (c) => {
    const parsed = RegisterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = {
        code: 'validation_error',
        message: 'Invalid body',
        details: parsed.error.flatten(),
      };
      return c.json(err, 400);
    }
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    if (existing[0]) {
      const err: ApiError = { code: 'conflict', message: 'Email already registered' };
      return c.json(err, 409);
    }

    const id = uuidv7();
    await db.insert(users).values({
      id,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      name: parsed.data.name,
      role: 'member',
    });
    await writeAudit(db, {
      actorUserId: id,
      action: 'user.register',
      targetType: 'user',
      targetId: id,
    });
    const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!;
    return c.json({ user: toUserDTO(row) }, 201);
  });

  app.post('/login', async (c) => {
    const parsed = LoginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = { code: 'validation_error', message: 'Invalid body' };
      return c.json(err, 400);
    }
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!defaultLoginLimiter.tryConsume(ip, parsed.data.email)) {
      const err: ApiError = { code: 'rate_limited', message: 'Too many login attempts' };
      return c.json(err, 429);
    }

    const row = (
      await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1)
    )[0];
    const passwordOk =
      row && row.active
        ? await verifyPassword(row.passwordHash, parsed.data.password)
        : (await equalizeVerifyCost(parsed.data.password), false);

    if (!row || !row.active || !passwordOk) {
      const err: ApiError = { code: 'unauthorized', message: 'Invalid email or password' };
      return c.json(err, 401);
    }

    defaultLoginLimiter.reset(ip, parsed.data.email);
    const token = await createSession(db, row.id);
    setSessionCookie(c, token, opts.secureCookie);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));
    await writeAudit(db, {
      actorUserId: row.id,
      action: 'user.login',
      targetType: 'user',
      targetId: row.id,
      payload: { ip },
    });
    return c.json({ user: toUserDTO({ ...row, lastLoginAt: new Date() }) });
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      await deleteSession(db, token);
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get('/me', requireUser(db), async (c) => {
    const u = c.var.user;
    const row = (await db.select().from(users).where(eq(users.id, u.id)).limit(1))[0]!;
    return c.json(toUserDTO(row));
  });

  return app;
}
