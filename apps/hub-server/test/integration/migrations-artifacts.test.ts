// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('migration 0003_artifacts', () => {
  let pg: PgFixture;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    pg = await startPostgres();
    sql = postgres(pg.url);
  }, 120_000);

  afterAll(async () => {
    await sql.end();
    await pg.stop();
  });

  it('creates artifacts table', async () => {
    const [row] = await sql<{ t: string | null }[]>`SELECT to_regclass('artifacts')::text AS t`;
    expect(row?.t).toBe('artifacts');
  });

  it('creates artifact_versions table', async () => {
    const [row] = await sql<
      { t: string | null }[]
    >`SELECT to_regclass('artifact_versions')::text AS t`;
    expect(row?.t).toBe('artifact_versions');
  });

  it('creates install_events table', async () => {
    const [row] = await sql<
      { t: string | null }[]
    >`SELECT to_regclass('install_events')::text AS t`;
    expect(row?.t).toBe('install_events');
  });

  it('creates GIN index on artifact_versions.manifest', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'artifact_versions'
        AND indexname = 'artifact_versions_manifest_gin'
    `;
    expect(rows).toHaveLength(1);
  });

  it('enforces unique (artifact_id, version)', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'artifact_versions'
        AND indexname = 'artifact_versions_artifact_version_uq'
    `;
    expect(rows).toHaveLength(1);
  });
});
