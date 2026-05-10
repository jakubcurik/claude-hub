// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { artifacts, artifactVersions, auditLog } from '../db/schema.js';
import { requireUser, type AuthEnv } from '../middleware/auth.js';
import { artifactTypeSchema, semverSchema, sha256Schema, slugSchema } from '../lib/validators.js';
import { artifactManifestSchema, type ArtifactManifest } from '../lib/manifest-schema.js';
import { manifestKey, presignDownload, putArtifactBlob, storageKey } from '../storage/minio.js';

const listQuerySchema = z.object({
  type: artifactTypeSchema.optional(),
  q: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

type ParsedUpload =
  | {
      ok: true;
      slug: string;
      type: 'skill' | 'plugin' | 'command' | 'agent';
      version: string;
      description: string;
      sha256: string;
      manifest: ArtifactManifest;
      blob: Blob;
    }
  | { ok: false; error: ApiError };

function parseUpload(form: FormData): ParsedUpload {
  try {
    const slug = slugSchema.parse(form.get('slug'));
    const type = artifactTypeSchema.parse(form.get('type'));
    const version = semverSchema.parse(form.get('version'));
    const description = String(form.get('description') ?? '');
    const sha256 = sha256Schema.parse(form.get('sha256'));
    const manifest = artifactManifestSchema.parse(JSON.parse(String(form.get('manifest'))));
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return { ok: false, error: { code: 'invalid_input', message: 'file required' } };
    }
    return { ok: true, slug, type, version, description, sha256, manifest, blob: file };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: e instanceof Error ? e.message : 'invalid input',
      },
    };
  }
}

export function buildArtifactsRoutes(db: Db) {
  const app = new Hono<AuthEnv>();

  app.post('/upload', requireUser(db), async (c) => {
    const user = c.get('user');
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json<ApiError>({ code: 'invalid_input', message: 'expected multipart' }, 400);
    }

    const parsed = parseUpload(form);
    if (!parsed.ok) return c.json<ApiError>(parsed.error, 400);
    const { slug, type, version, description, sha256, manifest, blob } = parsed;

    if (type !== 'skill') {
      return c.json<ApiError>(
        { code: 'unsupported_type', message: 'only skill supported in MVP' },
        400,
      );
    }

    const buf = Buffer.from(await blob.arrayBuffer());
    const computed = createHash('sha256').update(buf).digest('hex');
    if (computed !== sha256) {
      return c.json<ApiError>({ code: 'sha256_mismatch', message: 'sha256 mismatch' }, 400);
    }

    const existing = await db.select().from(artifacts).where(eq(artifacts.slug, slug)).limit(1);
    const existingRow = existing[0];
    if (existingRow && existingRow.ownerUserId !== user.id) {
      return c.json<ApiError>({ code: 'slug_taken', message: 'slug taken' }, 409);
    }

    return await db.transaction(async (tx) => {
      let artifactId: string;
      if (existingRow) {
        artifactId = existingRow.id;
        const dup = await tx
          .select()
          .from(artifactVersions)
          .where(
            and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.version, version)),
          )
          .limit(1);
        if (dup[0]) {
          return c.json<ApiError>({ code: 'version_exists', message: 'version exists' }, 409);
        }
      } else {
        artifactId = uuidv7();
        await tx
          .insert(artifacts)
          .values({ id: artifactId, slug, type, description, ownerUserId: user.id });
      }
      const sk = storageKey(artifactId, version);
      await putArtifactBlob(sk, buf);
      await putArtifactBlob(
        manifestKey(artifactId, version),
        Buffer.from(JSON.stringify(manifest)),
        'application/json',
      );
      const versionId = uuidv7();
      await tx.insert(artifactVersions).values({
        id: versionId,
        artifactId,
        version,
        storageKey: sk,
        sha256,
        manifest,
        publishedByUserId: user.id,
      });
      await tx.insert(auditLog).values({
        id: uuidv7(),
        actorUserId: user.id,
        action: 'artifact.publish',
        targetType: 'artifact_version',
        targetId: versionId,
        payload: { slug, version },
      });
      // TODO(plan-3-t17): broadcast catalog.update via gateway
      return c.json({ artifactId, versionId }, 201);
    });
  });

  app.get('/', requireUser(db), async (c) => {
    const params = Object.fromEntries(new URL(c.req.url).searchParams);
    let parsed: z.infer<typeof listQuerySchema>;
    try {
      parsed = listQuerySchema.parse(params);
    } catch (e) {
      return c.json<ApiError>(
        { code: 'invalid_input', message: e instanceof Error ? e.message : 'invalid query' },
        400,
      );
    }
    const { type, q, page, limit } = parsed;

    const conds = [isNull(artifacts.archivedAt)];
    if (type) conds.push(eq(artifacts.type, type));
    if (q) conds.push(ilike(artifacts.description, `%${q}%`));
    const where = and(...conds);

    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(artifacts)
      .where(where);
    const total = countRows[0]?.count ?? 0;

    const rows = await db
      .select({
        id: artifacts.id,
        slug: artifacts.slug,
        type: artifacts.type,
        description: artifacts.description,
        ownerUserId: artifacts.ownerUserId,
        createdAt: artifacts.createdAt,
        archivedAt: artifacts.archivedAt,
        latestVersion: sql<string | null>`(
          SELECT version FROM ${artifactVersions} av
          WHERE av.artifact_id = ${artifacts.id} AND av.deprecated = false
          ORDER BY string_to_array(av.version, '.')::int[] DESC
          LIMIT 1
        )`,
      })
      .from(artifacts)
      .where(where)
      .orderBy(desc(artifacts.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    return c.json({ items: rows, page, limit, total });
  });

  app.get('/:slug', requireUser(db), async (c) => {
    let slug: string;
    try {
      slug = slugSchema.parse(c.req.param('slug'));
    } catch (e) {
      return c.json<ApiError>(
        { code: 'invalid_input', message: e instanceof Error ? e.message : 'invalid slug' },
        400,
      );
    }
    const aRows = await db.select().from(artifacts).where(eq(artifacts.slug, slug)).limit(1);
    const a = aRows[0];
    if (!a) {
      return c.json<ApiError>({ code: 'not_found', message: 'artifact not found' }, 404);
    }
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, a.id))
      .orderBy(desc(artifactVersions.publishedAt));
    return c.json({ artifact: a, versions });
  });

  app.get('/:slug/versions/:version', requireUser(db), async (c) => {
    let slug: string;
    let version: string;
    try {
      slug = slugSchema.parse(c.req.param('slug'));
      version = semverSchema.parse(c.req.param('version'));
    } catch (e) {
      return c.json<ApiError>(
        { code: 'invalid_input', message: e instanceof Error ? e.message : 'invalid input' },
        400,
      );
    }
    const rows = await db
      .select()
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(and(eq(artifacts.slug, slug), eq(artifactVersions.version, version)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return c.json<ApiError>({ code: 'not_found', message: 'version not found' }, 404);
    }
    return c.json(row.artifact_versions);
  });

  app.get('/:slug/versions/:version/download', requireUser(db), async (c) => {
    let slug: string;
    let version: string;
    try {
      slug = slugSchema.parse(c.req.param('slug'));
      version = semverSchema.parse(c.req.param('version'));
    } catch (e) {
      return c.json<ApiError>(
        { code: 'invalid_input', message: e instanceof Error ? e.message : 'invalid params' },
        400,
      );
    }
    const rows = await db
      .select({
        key: artifactVersions.storageKey,
        sha: artifactVersions.sha256,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(and(eq(artifacts.slug, slug), eq(artifactVersions.version, version)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return c.json<ApiError>({ code: 'not_found', message: 'version not found' }, 404);
    }
    const url = await presignDownload(row.key, 300);
    return c.json({ downloadUrl: url, sha256: row.sha });
  });

  app.post('/:slug/yank', requireUser(db), async (c) => {
    let slug: string;
    try {
      slug = slugSchema.parse(c.req.param('slug'));
    } catch (e) {
      return c.json<ApiError>(
        { code: 'invalid_input', message: e instanceof Error ? e.message : 'invalid slug' },
        400,
      );
    }
    const user = c.get('user');
    const aRows = await db.select().from(artifacts).where(eq(artifacts.slug, slug)).limit(1);
    const a = aRows[0];
    if (!a) {
      return c.json<ApiError>({ code: 'not_found', message: 'artifact not found' }, 404);
    }
    if (a.ownerUserId !== user.id && user.role !== 'admin') {
      return c.json<ApiError>({ code: 'forbidden', message: 'forbidden' }, 403);
    }
    await db
      .update(artifactVersions)
      .set({ deprecated: true })
      .where(eq(artifactVersions.artifactId, a.id));
    await db.insert(auditLog).values({
      id: uuidv7(),
      actorUserId: user.id,
      action: 'artifact.yank',
      targetType: 'artifact',
      targetId: a.id,
      payload: { slug },
    });
    return c.json({ ok: true });
  });

  return app;
}
