// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { artifacts, artifactVersions, auditLog } from '../db/schema.js';
import { requireUser, type AuthEnv } from '../middleware/auth.js';
import { artifactTypeSchema, semverSchema, sha256Schema, slugSchema } from '../lib/validators.js';
import { artifactManifestSchema, type ArtifactManifest } from '../lib/manifest-schema.js';
import { manifestKey, putArtifactBlob, storageKey } from '../storage/minio.js';

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

  return app;
}
