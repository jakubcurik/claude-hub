// SPDX-License-Identifier: Apache-2.0
'use server';
import { redirect } from 'next/navigation';

export async function registerAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const name = String(formData.get('name') ?? '');
  const base = process.env.HUB_SERVER_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? 'Registration failed');
  }
  redirect('/login');
}
