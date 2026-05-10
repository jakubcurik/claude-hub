// SPDX-License-Identifier: Apache-2.0
import type { ApiError, UserDTO } from '@claude-hub/shared-types';

const BASE = process.env.HUB_SERVER_URL ?? '';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiError;
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  setupStatus: () => call<{ needsSetup: boolean }>('/api/setup/status'),
  setupInit: (body: { email: string; password: string; name: string }) =>
    call<{ user: UserDTO }>('/api/setup/init', { method: 'POST', body: JSON.stringify(body) }),
  register: (body: { email: string; password: string; name: string }) =>
    call<{ user: UserDTO }>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: { email: string; password: string }) =>
    call<{ user: UserDTO }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => call<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => call<UserDTO>('/api/auth/me'),
};
