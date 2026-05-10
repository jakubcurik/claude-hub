// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from './db/client.js';
import { buildAuthRoutes } from './routes/auth.js';
import { buildSetupRoutes } from './routes/setup.js';

export interface AppOptions {
  db?: Db;
  skipDb?: boolean;
  secureCookie?: boolean;
}

export function buildApp(opts: AppOptions = {}) {
  const app = new Hono();
  app.use('*', honoLogger());

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  if (opts.db) {
    app.route('/api/auth', buildAuthRoutes(opts.db, { secureCookie: opts.secureCookie ?? false }));
    app.route('/api/setup', buildSetupRoutes(opts.db));
  }

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
