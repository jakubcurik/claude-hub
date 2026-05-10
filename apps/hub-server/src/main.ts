// SPDX-License-Identifier: Apache-2.0
import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { createDb } from './db/client.js';
import { createMinioClient } from './storage/minio.js';

async function main() {
  const env = loadEnv();
  const logger = createLogger(env);
  const db = createDb(env.DATABASE_URL);
  const minio = createMinioClient({
    endpoint: env.MINIO_ENDPOINT,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    bucket: env.MINIO_BUCKET,
  });

  const app = buildApp({
    db,
    minio,
    secureCookie: env.NODE_ENV === 'production',
    publicUrl: env.PUBLIC_URL,
  });

  const [host, portStr] = env.HUB_BIND_ADDR.split(':');
  const hostname = host ?? '0.0.0.0';
  const port = Number.parseInt(portStr ?? '3000', 10);

  serve({ fetch: app.fetch, hostname, port }, (info) => {
    logger.info({ port: info.port, host: hostname }, 'hub-server listening');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
