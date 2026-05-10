// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('app', () => {
  it('GET /healthz returns 200 ok', async () => {
    const app = buildApp({ skipDb: true });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /unknown returns 404 with ApiError shape', async () => {
    const app = buildApp({ skipDb: true });
    const res = await app.request('/api/unknown');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'not_found' });
  });
});
