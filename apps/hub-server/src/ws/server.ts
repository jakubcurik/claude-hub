// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { daemons } from '../db/schema.js';
import type { ConnectionManager, WSLike } from './manager.js';
import { parseMessage, makePing } from '@claude-hub/wss-protocol';

interface WSVariables {
  daemonId: string;
}

export function attachWSS(app: Hono, db: Db, connections: ConnectionManager) {
  const wsApp = new Hono<{ Variables: WSVariables }>();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  wsApp.get(
    '/ws',
    async (c, next) => {
      const auth = c.req.header('Authorization') ?? '';
      if (!auth.startsWith('Bearer ')) {
        return c.body(null, 401);
      }
      const token = auth.slice('Bearer '.length);
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const [d] = await db
        .select({ id: daemons.id })
        .from(daemons)
        .where(eq(daemons.tokenHash, tokenHash))
        .limit(1);
      if (!d) {
        return c.body(null, 401);
      }
      c.set('daemonId', d.id);
      await next();
    },
    upgradeWebSocket((c) => {
      const daemonId = c.get('daemonId');
      return {
        onOpen: (_evt, ws) => {
          const wsLike: WSLike = {
            send: (s) => ws.send(s),
            close: () => ws.close(),
          };
          connections.connect(daemonId, wsLike);
          ws.send(JSON.stringify(makePing(uuidv7())));
        },
        onMessage: async (ev) => {
          try {
            const raw =
              typeof ev.data === 'string'
                ? ev.data
                : ev.data instanceof ArrayBuffer
                  ? Buffer.from(ev.data).toString('utf-8')
                  : String(ev.data);
            const msg = parseMessage(raw);
            if (msg.type === 'pong') {
              await db
                .update(daemons)
                .set({ lastSeenAt: new Date() })
                .where(eq(daemons.id, daemonId));
            }
          } catch {
            // drop malformed
          }
        },
        onClose: () => connections.disconnect(daemonId),
        onError: () => connections.disconnect(daemonId),
      };
    }),
  );

  app.route('/', wsApp);

  return { injectWebSocket };
}
