// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  globalSetup: './global-setup.ts',
  webServer: [
    {
      command: 'pnpm --filter hub-server start',
      port: 3000,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: {
        DATABASE_URL: process.env.E2E_DATABASE_URL!,
        MINIO_ENDPOINT: process.env.E2E_MINIO_ENDPOINT!,
        MINIO_ACCESS_KEY: 'minioadmin',
        MINIO_SECRET_KEY: 'minioadmin',
        MINIO_BUCKET: 'claude-hub-artifacts',
        SESSION_SECRET: 'e2e-only-insecure-session-secret-32bytes-long',
        PUBLIC_URL: 'http://localhost:3001',
        NODE_ENV: 'test',
      },
    },
    {
      command: 'pnpm --filter dashboard start',
      port: 3001,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: { HUB_SERVER_URL: 'http://localhost:3000' },
    },
  ],
});
