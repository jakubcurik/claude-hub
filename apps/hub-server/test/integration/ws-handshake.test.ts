// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import WebSocket from 'ws';
import { serve, type ServerType } from '@hono/node-server';
import { buildApp } from '../../src/app.js';
import { attachWSS } from '../../src/ws/server.js';
import { connectionManager } from '../../src/ws/manager.js';
import { users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

interface DaemonRow {
  id: string;
  lastSeenAt: string;
}

async function pairAndRegister(
  app: ReturnType<typeof buildApp>,
  cookie: string,
): Promise<{ daemonId: string; deviceToken: string }> {
  const pairRes = await app.request('/api/daemons/pair', { method: 'POST', headers: { cookie } });
  const { pin } = (await pairRes.json()) as { pin: string };
  const regRes = await app.request('/api/daemons/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin, hostname: 'h', os: 'linux', agentVersion: '0.1.0' }),
  });
  return regRes.json() as Promise<{ daemonId: string; deviceToken: string }>;
}

describe('WSS /ws', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;
  let server: ServerType;
  let port: number;
  let aliceCookie: string;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
    const handle = attachWSS(app, pg.db, connectionManager);
    server = serve({ fetch: app.fetch, port: 0 });
    handle.injectWebSocket(server);
    await new Promise<void>((r) => setTimeout(r, 50));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pg.stop();
  });

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings, daemons CASCADE`);
    const aliceId = uuidv7();
    const hash = await hashPassword('seed-password-1234');
    await pg.db.insert(users).values([
      {
        id: aliceId,
        email: 'alice@example.com',
        passwordHash: hash,
        name: 'Alice',
        role: 'member',
      },
    ]);
    aliceCookie = `hub_session=${await createSession(pg.db, aliceId)}`;
  });

  it('rejects connection without Authorization header', async () => {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        ws.terminate();
        resolve();
      });
      ws.on('error', () => resolve());
      ws.on('open', () => {
        ws.close();
        throw new Error('expected 401, got open');
      });
    });
  });

  it('accepts valid device_token, replies pong, stamps last_seen_at', async () => {
    const { deviceToken, daemonId } = await pairAndRegister(app, aliceCookie);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: { Authorization: `Bearer ${deviceToken}` },
      });
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as { type: string; id: string };
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', id: msg.id, payload: {} }));
          setTimeout(() => {
            ws.close();
            resolve();
          }, 200);
        }
      });
      ws.on('error', reject);
    });

    await new Promise<void>((r) => setTimeout(r, 200));
    const listRes = await app.request('/api/daemons', { headers: { cookie: aliceCookie } });
    const body = (await listRes.json()) as { daemons: DaemonRow[] };
    const d = body.daemons.find((x: { id: string }) => x.id === daemonId);
    expect(d).toBeDefined();
    expect(new Date(d!.lastSeenAt).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});
