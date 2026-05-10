// SPDX-License-Identifier: Apache-2.0
import pino from 'pino';
import type { Env } from './env.js';

export function createLogger(env: Env) {
  return pino({
    level: env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash'],
  });
}
