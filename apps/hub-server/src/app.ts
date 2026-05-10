// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { sql } from 'drizzle-orm';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from './db/client.js';
import type { MinioContext } from './storage/minio.js';
import { buildAuthRoutes } from './routes/auth.js';
import { buildSetupRoutes } from './routes/setup.js';
import { buildUsersRoutes } from './routes/users.js';
import { buildInvitationsRoutes } from './routes/invitations.js';
import { buildDaemonsRoutes } from './routes/daemons.js';
import { buildArtifactsRoutes } from './routes/artifacts.js';
import { buildLocalRoutes } from './routes/local.js';

export interface AppOptions {
  db?: Db;
  minio?: MinioContext;
  skipDb?: boolean;
  secureCookie?: boolean;
  publicUrl?: string;
}

export function buildApp(opts: AppOptions = {}) {
  const app = new Hono();
  app.use('*', honoLogger());

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/readyz', async (c) => {
    const result: Record<string, string> = {};
    let status: 200 | 503 = 200;
    if (opts.db) {
      try {
        await opts.db.execute(sql`select 1`);
        result.db = 'ok';
      } catch {
        result.db = 'fail';
        status = 503;
      }
    }
    if (opts.minio) {
      try {
        await opts.minio.ping();
        result.minio = 'ok';
      } catch {
        result.minio = 'fail';
        status = 503;
      }
    }
    return c.json(result, status);
  });

  if (opts.db) {
    app.route('/api/auth', buildAuthRoutes(opts.db, { secureCookie: opts.secureCookie ?? false }));
    app.route('/api/setup', buildSetupRoutes(opts.db));
    app.route(
      '/api/users',
      buildUsersRoutes(opts.db, { publicUrl: opts.publicUrl ?? 'http://localhost:3000' }),
    );
    app.route(
      '/api/invitations',
      buildInvitationsRoutes(opts.db, { secureCookie: opts.secureCookie ?? false }),
    );
    app.route('/api/daemons', buildDaemonsRoutes(opts.db));
    app.route('/api/artifacts', buildArtifactsRoutes(opts.db));
    app.route('/api/local', buildLocalRoutes(opts.db));
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
