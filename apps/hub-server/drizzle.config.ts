// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: '../../ops/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub',
  },
  strict: true,
  verbose: true,
});
