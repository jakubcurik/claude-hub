// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { buildApp } from '../../src/app.js';
import { Gateway } from '../../src/ws/gateway.js';
import { __resetJobsForTests } from '../../src/ws/jobs.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';
import { __resetMinioClientForTests, bootstrapBucket } from '../../src/storage/minio.js';
import { installEvents } from '../../src/db/schema.js';
import { loginAs, seedArtifact, pairFakeDaemon, attachFakeDaemonReply } from '../helpers/auth.js';
import { buildInstallRequestRoutes } from '../../src/routes/local.js';

describe('POST /api/install-request', () => {
  let pg: PgFixture;
  let mn: MinioFixture;
  let gw: Gateway;
  let app: Hono;

  beforeAll(async () => {
    pg = await startPostgres();
    mn = await startMinio();
    process.env.MINIO_ENDPOINT = mn.endpoint;
    process.env.MINIO_ACCESS_KEY = mn.accessKey;
    process.env.MINIO_SECRET_KEY = mn.secretKey;
    process.env.MINIO_BUCKET = 'claude-hub-artifacts';
    __resetMinioClientForTests();
    await bootstrapBucket();
  }, 180_000);

  beforeEach(async () => {
    await pg.db.execute(
      sql`TRUNCATE users, sessions, audit_log, pairings, daemons, artifacts, artifact_versions, install_events CASCADE`,
    );
    __resetJobsForTests();
    gw = new Gateway();
    const base = buildApp({ db: pg.db });
    base.route('/api-test', buildInstallRequestRoutes(pg.db, gw));
    app = base;
  });

  afterAll(async () => {
    __resetMinioClientForTests();
    await mn.stop();
    await pg.stop();
  });

  it('happy path inserts install_event and returns ok', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const seeded = await seedArtifact(app, cookie, {
      slug: 'inst',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    const { daemonId, socket } = await pairFakeDaemon(pg.db, cookie, gw);
    attachFakeDaemonReply(socket, () => ({ ok: true }));

    const r = await app.request('/api-test/install-request', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId: seeded.artifactId,
        version: '0.1.0',
        daemonId,
      }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });

    const events = await pg.db
      .select()
      .from(installEvents)
      .where(eq(installEvents.daemonId, daemonId));
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('success');
  });

  it('returns 403 for cross-user daemon', async () => {
    const aliceCookie = await loginAs(pg.db, 'alice@example.com');
    const seeded = await seedArtifact(app, aliceCookie, {
      slug: 'inst2',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    const { daemonId } = await pairFakeDaemon(pg.db, aliceCookie, gw);
    const bobCookie = await loginAs(pg.db, 'bob@example.com');
    const r = await app.request('/api-test/install-request', {
      method: 'POST',
      headers: { cookie: bobCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId: seeded.artifactId,
        version: '0.1.0',
        daemonId,
      }),
    });
    expect(r.status).toBe(403);
  });

  it('returns 503 when daemon offline', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const seeded = await seedArtifact(app, cookie, {
      slug: 'inst3',
      type: 'skill',
      description: 'd',
      version: '0.1.0',
    });
    const { daemonId } = await pairFakeDaemon(pg.db, cookie, gw, { online: false });
    const r = await app.request('/api-test/install-request', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId: seeded.artifactId,
        version: '0.1.0',
        daemonId,
      }),
    });
    expect(r.status).toBe(503);
  });
});
