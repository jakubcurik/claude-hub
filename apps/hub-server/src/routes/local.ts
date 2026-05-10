// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { artifacts, artifactVersions, daemons, installEvents } from '../db/schema.js';
import { requireUser, type AuthEnv } from '../middleware/auth.js';
import { artifactTypeSchema, semverSchema, slugSchema } from '../lib/validators.js';
import type { Gateway } from '../ws/gateway.js';
import { gateway as defaultGateway } from '../ws/gateway.js';
import { sendJob } from '../ws/jobs.js';
import { presignDownload } from '../storage/minio.js';

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

const installRequestBodySchema = z.object({
  artifactId: z.string().uuid(),
  version: semverSchema,
  daemonId: z.string().uuid(),
});

export function buildInstallRequestRoutes(db: Db, gw: Gateway = defaultGateway) {
  const app = new Hono<AuthEnv>();

  app.post('/install-request', requireUser(db), async (c) => {
    const user = c.get('user');
    let body: z.infer<typeof installRequestBodySchema>;
    try {
      body = installRequestBodySchema.parse(await c.req.json());
    } catch (e) {
      return c.json<ApiError>(
        { code: 'invalid_input', message: e instanceof Error ? e.message : 'invalid body' },
        400,
      );
    }

    const dRows = await db
      .select()
      .from(daemons)
      .where(and(eq(daemons.id, body.daemonId), eq(daemons.userId, user.id)))
      .limit(1);
    if (!dRows[0]) {
      return c.json<ApiError>({ code: 'forbidden', message: 'daemon not yours' }, 403);
    }

    const vRows = await db
      .select({
        id: artifactVersions.id,
        key: artifactVersions.storageKey,
        sha: artifactVersions.sha256,
        slug: artifacts.slug,
        type: artifacts.type,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(
        and(
          eq(artifactVersions.artifactId, body.artifactId),
          eq(artifactVersions.version, body.version),
        ),
      )
      .limit(1);
    const v = vRows[0];
    if (!v) {
      return c.json<ApiError>({ code: 'not_found', message: 'version not found' }, 404);
    }

    const url = await presignDownload(v.key, 300);
    const targetPath = `~/.claude/skills/${v.slug}`;

    try {
      const result = await sendJob(
        gw,
        body.daemonId,
        'job.install',
        {
          artifactVersionId: v.id,
          type: v.type,
          slug: v.slug,
          version: body.version,
          sha256: v.sha,
          downloadUrl: url,
          targetPath,
        },
        120_000,
      );
      await db.insert(installEvents).values({
        id: uuidv7(),
        daemonId: body.daemonId,
        artifactVersionId: v.id,
        status: result.ok ? 'success' : 'failed',
      });
      if (!result.ok) {
        return c.json<ApiError>(
          { code: 'internal_error', message: result.error ?? 'install failed' },
          502,
        );
      }
      return c.json({ ok: true });
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
