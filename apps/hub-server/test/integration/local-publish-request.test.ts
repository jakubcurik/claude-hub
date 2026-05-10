// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { buildApp } from '../../src/app.js';
import { Gateway } from '../../src/ws/gateway.js';
import { __resetJobsForTests } from '../../src/ws/jobs.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { loginAs, pairFakeDaemon, attachFakeDaemonReply } from '../helpers/auth.js';
import { buildLocalRoutes } from '../../src/routes/local.js';

describe('POST /api/local/:daemonId/publish-request', () => {
  let pg: PgFixture;
  let gw: Gateway;
  let app: Hono;

  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(
      sql`TRUNCATE users, sessions, audit_log, pairings, daemons, artifacts, artifact_versions, install_events CASCADE`,
    );
    __resetJobsForTests();
    gw = new Gateway();
    const base = buildApp({ db: pg.db });
    base.route('/api/local-test', buildLocalRoutes(pg.db, gw));
    app = base;
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('forwards job.package and returns daemon result', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const { daemonId, socket } = await pairFakeDaemon(pg.db, cookie, gw);
    attachFakeDaemonReply(socket, () => ({
      ok: true,
      data: { artifactId: 'a-1', versionId: 'v-1' },
    }));
    const r = await app.request(`/api/local-test/${daemonId}/publish-request`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'foo',
        type: 'skill',
        version: '0.1.0',
        description: 'd',
        sourcePath: '/x',
      }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ artifactId: 'a-1', versionId: 'v-1' });
  });

  it('returns 403 when daemon belongs to another user', async () => {
    const aliceCookie = await loginAs(pg.db, 'alice@example.com');
    const { daemonId } = await pairFakeDaemon(pg.db, aliceCookie, gw);
    const bobCookie = await loginAs(pg.db, 'bob@example.com');
    const r = await app.request(`/api/local-test/${daemonId}/publish-request`, {
      method: 'POST',
      headers: { cookie: bobCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'x',
        type: 'skill',
        version: '0.1.0',
        description: 'd',
        sourcePath: '/x',
      }),
    });
    expect(r.status).toBe(403);
  });

  it('returns 503 when daemon is offline', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const { daemonId } = await pairFakeDaemon(pg.db, cookie, gw, { online: false });
    const r = await app.request(`/api/local-test/${daemonId}/publish-request`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'x',
        type: 'skill',
        version: '0.1.0',
        description: 'd',
        sourcePath: '/x',
      }),
    });
    expect(r.status).toBe(503);
  });

  it('rejects non-skill type with 400', async () => {
    const cookie = await loginAs(pg.db, 'alice@example.com');
    const { daemonId } = await pairFakeDaemon(pg.db, cookie, gw);
    const r = await app.request(`/api/local-test/${daemonId}/publish-request`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'x',
        type: 'plugin',
        version: '0.1.0',
        description: 'd',
        sourcePath: '/x',
      }),
    });
    expect(r.status).toBe(400);
  });
});
