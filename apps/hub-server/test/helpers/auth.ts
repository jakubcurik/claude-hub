// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  artifacts as artifactsTable,
  artifactVersions as versionsTable,
  users,
} from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import type { Db } from '../../src/db/client.js';
import type { buildApp } from '../../src/app.js';

const SHARED_PASSWORD = 'seed-password-1234';

export async function loginAs(
  db: Db,
  email: string,
  opts: { role?: 'admin' | 'member'; name?: string } = {},
): Promise<string> {
  const role = opts.role ?? 'member';
  const name = opts.name ?? email.split('@')[0] ?? 'user';

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
  } else {
    userId = uuidv7();
    const hash = await hashPassword(SHARED_PASSWORD);
    await db.insert(users).values({ id: userId, email, passwordHash: hash, name, role });
  }
  const token = await createSession(db, userId);
  return `hub_session=${token}`;
}

export async function promoteToAdmin(db: Db, email: string): Promise<void> {
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) {
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, existing[0].id));
  } else {
    const userId = uuidv7();
    const hash = await hashPassword(SHARED_PASSWORD);
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash: hash,
      name: email.split('@')[0] ?? 'admin',
      role: 'admin',
    });
  }
}

export interface SeedArtifactOpts {
  slug: string;
  type: 'skill' | 'plugin' | 'command' | 'agent';
  description: string;
  version: string;
  fileBytes?: Buffer;
}

export interface SeededArtifact {
  artifactId: string;
  versionId: string;
  sha256: string;
}

export async function seedArtifact(
  app: ReturnType<typeof buildApp>,
  cookie: string,
  opts: SeedArtifactOpts,
): Promise<SeededArtifact> {
  const fileBytes = opts.fileBytes ?? Buffer.from(`seed-${opts.slug}-${opts.version}`);
  const sha256 = createHash('sha256').update(fileBytes).digest('hex');
  const form = new FormData();
  form.set('slug', opts.slug);
  form.set('type', opts.type);
  form.set('version', opts.version);
  form.set('description', opts.description);
  form.set('sha256', sha256);
  form.set(
    'manifest',
    JSON.stringify({
      schemaVersion: 1,
      name: opts.slug,
      type: opts.type,
      description: opts.description,
      typeMeta: {},
    }),
  );
  form.set('file', new Blob([fileBytes], { type: 'application/gzip' }), `${opts.slug}.tar.gz`);

  const r = await app.request('/api/artifacts/upload', {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  if (r.status !== 201) {
    const body = await r.text();
    throw new Error(`seedArtifact failed: ${r.status} ${body}`);
  }
  const body = (await r.json()) as { artifactId: string; versionId: string };
  return { artifactId: body.artifactId, versionId: body.versionId, sha256 };
}

// Test-only direct DB update — Task 11's POST /yank endpoint will exercise the route path.
export async function yankArtifactVersions(
  db: Db,
  slug: string,
  versions: string[],
): Promise<void> {
  const a = await db.select().from(artifactsTable).where(eq(artifactsTable.slug, slug)).limit(1);
  const artifactId = a[0]?.id;
  if (!artifactId) throw new Error(`yankArtifactVersions: slug ${slug} not found`);
  await db
    .update(versionsTable)
    .set({ deprecated: true })
    .where(and(eq(versionsTable.artifactId, artifactId), inArray(versionsTable.version, versions)));
}
