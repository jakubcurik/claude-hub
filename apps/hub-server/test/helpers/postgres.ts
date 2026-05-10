// SPDX-License-Identifier: Apache-2.0
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';

export interface PgFixture {
  container: StartedPostgreSqlContainer;
  url: string;
  db: ReturnType<typeof drizzle<typeof schema>>;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<PgFixture> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('hub')
    .withUsername('hub')
    .withPassword('hub')
    .start();

  const url = container.getConnectionUri();
  const migrator = postgres(url, { max: 1 });
  await migrate(drizzle(migrator), { migrationsFolder: '../../ops/migrations' });
  await migrator.end();

  const client = postgres(url, { max: 5 });
  const db = drizzle(client, { schema });

  return {
    container,
    url,
    db,
    stop: async () => {
      await client.end();
      await container.stop();
    },
  };
}
