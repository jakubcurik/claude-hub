// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { daemons } from '../db/schema.js';
import { requireUser, type AuthEnv } from '../middleware/auth.js';
import { artifactTypeSchema, semverSchema, slugSchema } from '../lib/validators.js';
import type { Gateway } from '../ws/gateway.js';
import { gateway as defaultGateway } from '../ws/gateway.js';
import { sendJob } from '../ws/jobs.js';

const publishBodySchema = z.object({
  slug: slugSchema,
  type: artifactTypeSchema,
  version: semverSchema,
  description: z.string().min(1),
  sourcePath: z.string().min(1),
});

export function buildLocalRoutes(db: Db, gw: Gateway = defaultGateway) {
  const app = new Hono<AuthEnv>();

  app.post('/:daemonId/publish-request', requireUser(db), async (c) => {
    const user = c.get('user');
    const daemonId = c.req.param('daemonId');

    const dRows = await db
      .select()
      .from(daemons)
      .where(and(eq(daemons.id, daemonId), eq(daemons.userId, user.id)))
      .limit(1);
    if (!dRows[0]) {
      return c.json<ApiError>({ code: 'forbidden', message: 'daemon not yours' }, 403);
    }

    let body: z.infer<typeof publishBodySchema>;
    try {
      body = publishBodySchema.parse(await c.req.json());
    } catch (e) {
      return c.json<ApiError>(
        { code: 'invalid_input', message: e instanceof Error ? e.message : 'invalid body' },
        400,
      );
    }
    if (body.type !== 'skill') {
      return c.json<ApiError>({ code: 'unsupported_type', message: 'only skill in MVP' }, 400);
    }

    try {
      const result = await sendJob(gw, daemonId, 'job.package', body, 60_000);
      if (!result.ok) {
        return c.json<ApiError>(
          { code: 'internal_error', message: result.error ?? 'job failed' },
          502,
        );
      }
      return c.json(result.data ?? {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      if (msg === 'daemon offline') {
        return c.json<ApiError>({ code: 'internal_error', message: 'daemon offline' }, 503);
      }
      throw e;
    }
  });

  return app;
}
