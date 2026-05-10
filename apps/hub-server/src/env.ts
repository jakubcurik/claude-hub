// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const EnvSchema = z.object({
  HUB_BIND_ADDR: z.string().default('0.0.0.0:3000'),
  DATABASE_URL: z.string().default('postgres://hub:hub@localhost:5432/hub'),
  MINIO_ENDPOINT: z.string().default('http://localhost:9000'),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),
  MINIO_BUCKET: z.string().default('claude-hub-artifacts'),
  SESSION_SECRET: z.string().min(32).default('dev-only-insecure-session-secret-do-not-use-in-prod'),
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
