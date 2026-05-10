// SPDX-License-Identifier: Apache-2.0
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import type { ApiError, UserRole } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { lookupSession } from '../auth/session.js';
import { SESSION_COOKIE } from '../auth/cookie.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface AuthEnv {
  Variables: {
    user: AuthUser;
  };
}

export function requireUser(db: Db) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) {
      const err: ApiError = { code: 'unauthorized', message: 'No session' };
      return c.json(err, 401);
    }
    const session = await lookupSession(db, token);
    if (!session) {
      const err: ApiError = { code: 'unauthorized', message: 'Invalid or expired session' };
      return c.json(err, 401);
    }
    const rows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    const u = rows[0];
    if (!u || !u.active) {
      const err: ApiError = { code: 'unauthorized', message: 'User not found or inactive' };
      return c.json(err, 401);
    }
    c.set('user', { id: u.id, email: u.email, name: u.name, role: u.role as UserRole });
    await next();
  });
}

export function requireRole(role: UserRole) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const u = c.var.user;
    if (!u || u.role !== role) {
      const err: ApiError = { code: 'forbidden', message: `Role '${role}' required` };
      return c.json(err, 403);
    }
    await next();
  });
}
