// SPDX-License-Identifier: Apache-2.0
import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'hub_session';

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
