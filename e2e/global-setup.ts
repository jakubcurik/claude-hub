// SPDX-License-Identifier: Apache-2.0
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { MinioContainer } from '@testcontainers/minio';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export default async function globalSetup() {
  const pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('hub')
    .withUsername('hub')
    .withPassword('hub')
    .start();
  const minio = await new MinioContainer('minio/minio:RELEASE.2024-10-13T13-34-11Z').start();

  process.env.E2E_DATABASE_URL = pg.getConnectionUri();
  // MinioContainer v10+ exposes getConnectionUrl() (full http URL); the plan's
  // getEndpoint() existed only in older versions. See apps/hub-server/test/helpers/minio.ts.
  process.env.E2E_MINIO_ENDPOINT = minio.getConnectionUrl();

  const migrator = postgres(pg.getConnectionUri(), { max: 1 });
  await migrate(drizzle(migrator), { migrationsFolder: '../ops/migrations' });
  await migrator.end();
}
