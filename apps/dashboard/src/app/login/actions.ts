// SPDX-License-Identifier: Apache-2.0
'use server';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const base = process.env.HUB_SERVER_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? 'Login failed');
  }
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/hub_session=([^;]+)/);
    if (m) {
      cookies().set('hub_session', m[1]!, { httpOnly: true, sameSite: 'lax', path: '/' });
    }
  }
  redirect('/');
}
