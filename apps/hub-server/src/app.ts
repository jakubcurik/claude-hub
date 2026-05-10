// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import type { ApiError } from '@claude-hub/shared-types';

export interface AppOptions {
  skipDb?: boolean;
}

export function buildApp(_opts: AppOptions = {}) {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.notFound((c) => {
    const err: ApiError = { code: 'not_found', message: 'Route not found' };
    return c.json(err, 404);
  });

  app.onError((err, c) => {
    const body: ApiError = { code: 'internal_error', message: 'Internal server error' };
    if (process.env.NODE_ENV !== 'production') {
      body.details = { stack: err.stack };
    }
    return c.json(body, 500);
  });

  return app;
}
