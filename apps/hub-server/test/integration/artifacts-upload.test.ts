// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { loginAs } from '../helpers/auth.js';

interface UploadOpts {
  slug: string;
  type: string;
  version: string;
  description: string;
  manifest: object;
  fileBytes: Buffer;
  sha256?: string;
}

function buildForm(opts: UploadOpts): FormData {
  const sha = opts.sha256 ?? createHash('sha256').update(opts.fileBytes).digest('hex');
  const form = new FormData();
  form.set('slug', opts.slug);
  form.set('type', opts.type);
  form.set('version', opts.version);
  form.set('description', opts.description);
  form.set('sha256', sha);
  form.set('manifest', JSON.stringify(opts.manifest));
  form.set('file', new Blob([opts.fileBytes], { type: 'application/gzip' }), 'a.tar.gz');
  return form;
}

describe('POST /api/artifacts/upload', () => {
  let pg: PgFixture;
  let mn: MinioFixture;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startPostgres();
    mn = await startMinio();
    process.env.MINIO_ENDPOINT = mn.endpoint;
    process.env.MINIO_ACCESS_KEY = mn.accessKey;
    process.env.MINIO_SECRET_KEY = mn.secretKey;
    process.env.MINIO_BUCKET = 'claude-hub-artifacts';
    __resetMinioClientForTests();
    await bootstrapBucket();
    app = buildApp({ db: pg.db });
  }, 180_000);

  beforeEach(async () => {
    await pg.db.execute(
      sql`TRUNCATE users, sessions, audit_log, pairings, daemons, artifacts, artifact_versions, install_events CASCADE`,
    );
  });

  afterAll(async () => {
    __resetMinioClientForTests();
    await mn.stop();
    await pg.stop();
  });

  it('rejects unauthenticated', async () => {
    const r = await app.request('/api/artifacts/upload', { method: 'POST' });
    expect(r.status).toBe(401);
  });

  it('accepts a valid skill upload (201)', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const form = buildForm({
      slug: 'demo',
      type: 'skill',
      version: '0.1.0',
      description: 'demo skill',
      manifest: {
        schemaVersion: 1,
        name: 'demo',
        type: 'skill',
        description: 'demo skill',
        typeMeta: {},
      },
      fileBytes: Buffer.from('fake-targz'),
    });
    const r = await app.request('/api/artifacts/upload', {
      method: 'POST',
      headers: { cookie },
      body: form,
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.versionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects duplicate (slug, version)', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const m = {
      schemaVersion: 1,
      name: 'dup',
      type: 'skill',
      description: 'd',
      typeMeta: {},
    };
    const ok = await app.request('/api/artifacts/upload', {
      method: 'POST',
      headers: { cookie },
      body: buildForm({
        slug: 'dup',
        type: 'skill',
        version: '0.1.0',
        description: 'd',
        manifest: m,
        fileBytes: Buffer.from('a'),
      }),
    });
    expect(ok.status).toBe(201);
    const dupResp = await app.request('/api/artifacts/upload', {
      method: 'POST',
      headers: { cookie },
      body: buildForm({
        slug: 'dup',
        type: 'skill',
        version: '0.1.0',
        description: 'd',
        manifest: m,
        fileBytes: Buffer.from('a'),
      }),
    });
    expect(dupResp.status).toBe(409);
  });

  it('rejects non-skill type in MVP with 400', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const r = await app.request('/api/artifacts/upload', {
      method: 'POST',
      headers: { cookie },
      body: buildForm({
        slug: 'plug',
        type: 'plugin',
        version: '0.1.0',
        description: 'p',
        manifest: {
          schemaVersion: 1,
          name: 'plug',
          type: 'plugin',
          description: 'p',
          typeMeta: {},
        },
        fileBytes: Buffer.from('p'),
      }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects sha256 mismatch', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const r = await app.request('/api/artifacts/upload', {
      method: 'POST',
      headers: { cookie },
      body: buildForm({
        slug: 'mismatch',
        type: 'skill',
        version: '0.1.0',
        description: 'm',
        manifest: {
          schemaVersion: 1,
          name: 'mismatch',
          type: 'skill',
          description: 'm',
          typeMeta: {},
        },
        fileBytes: Buffer.from('content'),
        sha256: 'a'.repeat(64),
      }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects slug owned by another user with 409', async () => {
    const aliceCookie = await loginAs(pg.db, 'alice@example.com');
    const m = {
      schemaVersion: 1,
      name: 'shared',
      type: 'skill',
      description: 's',
      typeMeta: {},
    };
    const ok = await app.request('/api/artifacts/upload', {
      method: 'POST',
      headers: { cookie: aliceCookie },
      body: buildForm({
        slug: 'shared',
        type: 'skill',
        version: '0.1.0',
        description: 's',
        manifest: m,
        fileBytes: Buffer.from('a'),
      }),
    });
    expect(ok.status).toBe(201);
    const bobCookie = await loginAs(pg.db, 'bob@example.com');
    const r = await app.request('/api/artifacts/upload', {
      method: 'POST',
      headers: { cookie: bobCookie },
      body: buildForm({
        slug: 'shared',
        type: 'skill',
        version: '0.2.0',
        description: 's',
        manifest: m,
        fileBytes: Buffer.from('b'),
      }),
    });
    expect(r.status).toBe(409);
  });
});
