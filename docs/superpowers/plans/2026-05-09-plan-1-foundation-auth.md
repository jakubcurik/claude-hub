# Foundation + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Postavit kostru Claude Hub monorepa s Postgres + MinIO stackem, Hono API serverem s Argon2id auth, RBAC, audit log, first-run wizard a Next.js shell — vše pokryté CI testy a Playwright smoke E2E.

**Architecture:** pnpm + go.work monorepo. `apps/hub-server` (Hono, Node 22) drží REST API; auth na opaque session tokenech v HttpOnly cookies, hesla přes Argon2id. Postgres 16 + MinIO běží přes `ops/docker/docker-compose.yml`, schema přes drizzle-orm/drizzle-kit migrace. `apps/dashboard` (Next.js 14 App Router + Tailwind + shadcn/ui) drží login/register/setup wizard. Sdílené TS typy v `packages/shared-types`. CI staví, lintuje, typechecká, pouští unit + integration (Testcontainers) + Playwright smoke.

**Tech Stack:**
- Node.js 22 LTS, pnpm 9 workspaces
- Hono 4, drizzle-orm + drizzle-kit, postgres-js
- @node-rs/argon2, pino, zod
- Next.js 14 App Router, React 18, Tailwind, shadcn/ui
- PostgreSQL 16, MinIO (RELEASE.2024-* edition)
- Vitest + Testcontainers, Playwright
- ESLint, Prettier, husky, lint-staged
- GitHub Actions

---

## Pořadí tasků

Tasky jsou seřazeny: **scaffolding (1–4) → DB layer (5–7) → server core (8–10) → auth (11–14) → admin endpoints (15–17) → UI (18–20) → CI + E2E (21–22)**. Každý task je 2–5 minut práce a končí commitem.

---

### Task 1: Repo scaffolding — root config

**Files:**
- Create: `D:/Claude/hub/.gitignore`
- Create: `D:/Claude/hub/.editorconfig`
- Create: `D:/Claude/hub/package.json`
- Create: `D:/Claude/hub/pnpm-workspace.yaml`
- Create: `D:/Claude/hub/go.work`
- Create: `D:/Claude/hub/README.md`
- Create: `D:/Claude/hub/LICENSE`

- [ ] **Step 1: Create `.gitignore` with Node + Go patterns**

```
# Node
node_modules/
.pnpm-store/
dist/
build/
.next/
coverage/
*.tsbuildinfo

# Go
apps/agent/bin/
apps/cli/bin/
*.exe
*.test
*.out

# Env
.env
.env.local
.env.*.local

# OS
.DS_Store
Thumbs.db

# Editors
.vscode/
.idea/
*.swp

# Test artifacts
playwright-report/
test-results/
```

- [ ] **Step 2: Create `.editorconfig`**

```
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.go]
indent_style = tab

[Makefile]
indent_style = tab
```

- [ ] **Step 3: Create root `package.json`**

```json
{
  "name": "claude-hub",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=9.0.0"
  },
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "build": "pnpm -r run build",
    "lint": "pnpm -r run lint",
    "typecheck": "pnpm -r run typecheck",
    "test": "pnpm -r run test",
    "test:e2e": "pnpm --filter e2e run test",
    "db:gen": "pnpm --filter hub-server run db:gen",
    "db:migrate": "pnpm --filter hub-server run db:migrate",
    "format": "prettier --write .",
    "prepare": "husky"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "eslint": "^9.13.0",
    "husky": "^9.1.6",
    "lint-staged": "^15.2.10",
    "prettier": "^3.3.3",
    "typescript": "^5.6.3"
  },
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml,yaml}": ["prettier --write"]
  }
}
```

- [ ] **Step 4: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "e2e"
```

- [ ] **Step 5: Create `go.work`**

```
go 1.23

use (
    ./apps/agent
    ./apps/cli
)
```

- [ ] **Step 6: Create `README.md` placeholder**

```markdown
# Claude Hub

Self-hosted, single-tenant team marketplace for Claude Code skills, plugins, commands and subagents.

See `docs/superpowers/specs/2026-05-09-claude-hub-design.md` for the design spec.

## Quick start

```bash
pnpm install
docker compose -f ops/docker/docker-compose.yml up -d
pnpm db:migrate
pnpm dev
```

## License

Apache 2.0 — see `LICENSE`.
```

- [ ] **Step 7: Create `LICENSE` (Apache 2.0)**

Use the standard Apache 2.0 text. Copy from https://www.apache.org/licenses/LICENSE-2.0.txt verbatim. Replace the `[yyyy]` and `[name of copyright owner]` placeholders with `2026` and `Kuba Curik`.

- [ ] **Step 8: Init git and commit**

```bash
cd D:/Claude/hub
git init
git add .
git commit -m "chore: initialize monorepo scaffolding"
```

---

### Task 2: Tooling — TypeScript, ESLint, Prettier, Husky

**Files:**
- Create: `D:/Claude/hub/tsconfig.base.json`
- Create: `D:/Claude/hub/.prettierrc.json`
- Create: `D:/Claude/hub/.prettierignore`
- Create: `D:/Claude/hub/eslint.config.mjs`
- Create: `D:/Claude/hub/.husky/pre-commit`

- [ ] **Step 1: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 2: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "endOfLine": "lf"
}
```

- [ ] **Step 3: Create `.prettierignore`**

```
node_modules/
dist/
build/
.next/
coverage/
playwright-report/
test-results/
ops/migrations/*.sql
```

- [ ] **Step 4: Create `eslint.config.mjs`**

```js
// SPDX-License-Identifier: Apache-2.0
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['**/dist/**', '**/.next/**', '**/build/**', '**/coverage/**'],
  },
);
```

- [ ] **Step 5: Add ESLint deps to root**

```bash
cd D:/Claude/hub
pnpm add -Dw @eslint/js typescript-eslint
```

- [ ] **Step 6: Create husky pre-commit hook**

```bash
cd D:/Claude/hub
pnpm exec husky init
```

Then overwrite `.husky/pre-commit` with:

```
pnpm lint-staged
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "chore: add typescript, eslint, prettier, husky tooling"
```

---

### Task 3: Docker compose — Postgres, MinIO, hub-server placeholder

**Files:**
- Create: `D:/Claude/hub/ops/docker/docker-compose.yml`
- Create: `D:/Claude/hub/ops/docker/Dockerfile.hub-server`
- Create: `D:/Claude/hub/ops/docker/.env.example`

- [ ] **Step 1: Create `ops/docker/docker-compose.yml`**

```yaml
name: claude-hub

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: hub
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-hub}
      POSTGRES_DB: hub
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hub -d hub"]
      interval: 5s
      timeout: 5s
      retries: 10
    ports:
      - "5432:5432"

  minio:
    image: minio/minio:RELEASE.2024-10-13T13-34-11Z
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 5s
      retries: 10
    ports:
      - "9000:9000"
      - "9001:9001"

  hub-server:
    build:
      context: ../..
      dockerfile: ops/docker/Dockerfile.hub-server
    restart: unless-stopped
    env_file: ./.env
    environment:
      DATABASE_URL: postgres://hub:${POSTGRES_PASSWORD:-hub}@postgres:5432/hub
      MINIO_ENDPOINT: http://minio:9000
      MINIO_ACCESS_KEY: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_SECRET_KEY: ${MINIO_ROOT_PASSWORD:-minioadmin}
      MINIO_BUCKET: claude-hub-artifacts
      HUB_BIND_ADDR: 0.0.0.0:3000
      LOG_LEVEL: info
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy
    ports:
      - "3000:3000"

volumes:
  pgdata:
  miniodata:
```

- [ ] **Step 2: Create `ops/docker/Dockerfile.hub-server`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/hub-server/package.json apps/hub-server/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/hub-server/node_modules ./apps/hub-server/node_modules
COPY . .
RUN pnpm --filter shared-types build && pnpm --filter hub-server build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "apps/hub-server/dist/main.js"]
```

- [ ] **Step 3: Create `ops/docker/.env.example`**

```
POSTGRES_PASSWORD=hub
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
SESSION_SECRET=replace-me-with-256-bit-base64
PUBLIC_URL=http://localhost:3000
```

- [ ] **Step 4: Verify compose file syntax**

Run: `docker compose -f D:/Claude/hub/ops/docker/docker-compose.yml config`
Expected: prints rendered compose without errors.

- [ ] **Step 5: Commit**

```bash
git add ops/
git commit -m "chore(ops): add docker-compose stack with postgres, minio, hub-server"
```

---

### Task 4: `packages/shared-types` — TS types from contracts

**Files:**
- Create: `D:/Claude/hub/packages/shared-types/package.json`
- Create: `D:/Claude/hub/packages/shared-types/tsconfig.json`
- Create: `D:/Claude/hub/packages/shared-types/src/index.ts`
- Create: `D:/Claude/hub/packages/shared-types/src/users.ts`
- Create: `D:/Claude/hub/packages/shared-types/src/artifacts.ts`
- Create: `D:/Claude/hub/packages/shared-types/src/daemons.ts`
- Create: `D:/Claude/hub/packages/shared-types/src/inventory.ts`
- Create: `D:/Claude/hub/packages/shared-types/src/api-error.ts`
- Test: `D:/Claude/hub/packages/shared-types/src/index.test.ts`

- [ ] **Step 1: Create `packages/shared-types/package.json`**

```json
{
  "name": "@claude-hub/shared-types",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch",
    "lint": "eslint src",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.3"
  }
}
```

- [ ] **Step 2: Create `packages/shared-types/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write failing test `src/index.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { UserDTO, UserRole, ArtifactType, DaemonOS, InventoryItem, ApiError } from './index.js';

describe('shared-types', () => {
  it('exposes UserRole as admin | member', () => {
    const roles: UserRole[] = ['admin', 'member'];
    expect(roles).toHaveLength(2);
  });

  it('UserDTO shape matches contract', () => {
    const user: UserDTO = {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'a@b.cz',
      name: 'A',
      role: 'admin',
      createdAt: '2026-05-09T00:00:00Z',
      lastLoginAt: null,
    };
    expect(user.role).toBe('admin');
  });

  it('ArtifactType union covers spec', () => {
    const types: ArtifactType[] = ['skill', 'plugin', 'command', 'agent'];
    expect(types).toHaveLength(4);
  });

  it('DaemonOS covers all platforms', () => {
    const oses: DaemonOS[] = ['windows', 'macos', 'linux'];
    expect(oses).toHaveLength(3);
  });

  it('InventoryItem requires path and type', () => {
    const item: InventoryItem = {
      type: 'skill',
      slug: 'foo',
      version: null,
      path: '~/.claude/skills/foo',
      enabled: null,
    };
    expect(item.slug).toBe('foo');
  });

  it('ApiError carries code and message', () => {
    const err: ApiError = { code: 'unauthorized', message: 'no session' };
    expect(err.code).toBe('unauthorized');
  });
});
```

- [ ] **Step 4: Run test, verify FAIL**

```bash
cd D:/Claude/hub/packages/shared-types
pnpm install
pnpm test
```

Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 5: Implement `src/users.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
export type UUID = string;

export type UserRole = 'admin' | 'member';

export interface UserDTO {
  id: UUID;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}
```

- [ ] **Step 6: Implement `src/artifacts.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import type { UUID } from './users.js';

export type ArtifactType = 'skill' | 'plugin' | 'command' | 'agent';

export interface ArtifactManifest {
  schemaVersion: 1;
  name: string;
  type: ArtifactType;
  description: string;
  typeMeta: Record<string, unknown>;
}

export interface ArtifactDTO {
  id: UUID;
  slug: string;
  type: ArtifactType;
  description: string;
  ownerUserId: UUID;
  createdAt: string;
  archivedAt: string | null;
  latestVersion: string | null;
}

export interface ArtifactVersionDTO {
  id: UUID;
  artifactId: UUID;
  version: string;
  sha256: string;
  manifest: ArtifactManifest;
  publishedByUserId: UUID;
  publishedAt: string;
  deprecated: boolean;
}
```

- [ ] **Step 7: Implement `src/daemons.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import type { UUID } from './users.js';

export type DaemonOS = 'windows' | 'macos' | 'linux';

export interface DaemonDTO {
  id: UUID;
  hostname: string;
  os: DaemonOS;
  agentVersion: string;
  pairedAt: string;
  lastSeenAt: string;
  online: boolean;
}
```

- [ ] **Step 8: Implement `src/inventory.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import type { UUID } from './users.js';
import type { ArtifactType } from './artifacts.js';

export interface PublishedAsRef {
  artifactId: UUID;
  version: string;
}

export interface InventoryItem {
  type: ArtifactType;
  slug: string;
  version: string | null;
  path: string;
  enabled: boolean | null;
  publishedAs?: PublishedAsRef;
}
```

- [ ] **Step 9: Implement `src/api-error.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'rate_limited'
  | 'conflict'
  | 'internal_error';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}
```

- [ ] **Step 10: Implement `src/index.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
export * from './users.js';
export * from './artifacts.js';
export * from './daemons.js';
export * from './inventory.js';
export * from './api-error.js';
```

- [ ] **Step 11: Run test, verify PASS**

```bash
cd D:/Claude/hub/packages/shared-types
pnpm test
```

Expected: 6 tests pass.

- [ ] **Step 12: Commit**

```bash
git add .
git commit -m "feat(shared-types): add user/artifact/daemon/inventory/error DTOs"
```

---

### Task 5: `apps/hub-server` — package skeleton + Hono entry

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/package.json`
- Create: `D:/Claude/hub/apps/hub-server/tsconfig.json`
- Create: `D:/Claude/hub/apps/hub-server/vitest.config.ts`
- Create: `D:/Claude/hub/apps/hub-server/src/main.ts`
- Create: `D:/Claude/hub/apps/hub-server/src/app.ts`
- Create: `D:/Claude/hub/apps/hub-server/src/env.ts`
- Test: `D:/Claude/hub/apps/hub-server/src/app.test.ts`

- [ ] **Step 1: Create `apps/hub-server/package.json`**

```json
{
  "name": "hub-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "lint": "eslint src",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:gen": "drizzle-kit generate --config=drizzle.config.ts",
    "db:migrate": "tsx src/db/migrate.ts"
  },
  "dependencies": {
    "@claude-hub/shared-types": "workspace:*",
    "@hono/node-server": "^1.13.2",
    "@node-rs/argon2": "^2.0.0",
    "drizzle-orm": "^0.36.0",
    "hono": "^4.6.5",
    "minio": "^8.0.2",
    "pino": "^9.5.0",
    "postgres": "^3.4.5",
    "uuid": "^11.0.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@testcontainers/minio": "^10.13.2",
    "@testcontainers/postgresql": "^10.13.2",
    "@types/uuid": "^10.0.0",
    "drizzle-kit": "^0.28.0",
    "testcontainers": "^10.13.2",
    "tsx": "^4.19.1",
    "vitest": "^2.1.3"
  }
}
```

- [ ] **Step 2: Create `apps/hub-server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "test/**"]
}
```

- [ ] **Step 3: Create `apps/hub-server/vitest.config.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```

- [ ] **Step 4: Write failing test `src/app.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('app', () => {
  it('GET /healthz returns 200 ok', async () => {
    const app = buildApp({ skipDb: true });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /unknown returns 404 with ApiError shape', async () => {
    const app = buildApp({ skipDb: true });
    const res = await app.request('/api/unknown');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'not_found' });
  });
});
```

- [ ] **Step 5: Run test, verify FAIL**

```bash
cd D:/Claude/hub/apps/hub-server
pnpm install
pnpm test
```

Expected: FAIL — `Cannot find module './app.js'`.

- [ ] **Step 6: Create `src/env.ts`**

```ts
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
```

- [ ] **Step 7: Create `src/app.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import type { ApiError } from '@claude-hub/shared-types';

export interface AppOptions {
  skipDb?: boolean;
}

export function buildApp(_opts: AppOptions = {}) {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.notFound((c) => {
    const err: ApiError = { code: 'not_found', message: 'Route not found' };
    return c.json(err, 404);
  });

  app.onError((err, c) => {
    const body: ApiError = { code: 'internal_error', message: 'Internal server error' };
    if (process.env.NODE_ENV !== 'production') {
      body.details = { stack: err.stack };
    }
    return c.json(body, 500);
  });

  return app;
}
```

- [ ] **Step 8: Create `src/main.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';

async function main() {
  const env = loadEnv();
  const logger = createLogger(env);
  const app = buildApp();

  const [host, portStr] = env.HUB_BIND_ADDR.split(':');
  const port = Number.parseInt(portStr ?? '3000', 10);

  serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    logger.info({ port: info.port, host }, 'hub-server listening');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 9: Create `src/logger.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import pino from 'pino';
import type { Env } from './env.js';

export function createLogger(env: Env) {
  return pino({
    level: env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash'],
  });
}
```

- [ ] **Step 10: Run test, verify PASS**

```bash
pnpm test
```

Expected: 2 tests pass.

- [ ] **Step 11: Commit**

```bash
git add .
git commit -m "feat(hub-server): add hono app skeleton with healthz, env loader, logger"
```

---

### Task 6: Drizzle schema — users, sessions, audit_log, pairings

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/drizzle.config.ts`
- Create: `D:/Claude/hub/apps/hub-server/src/db/schema.ts`
- Create: `D:/Claude/hub/apps/hub-server/src/db/client.ts`
- Create: `D:/Claude/hub/apps/hub-server/src/db/migrate.ts`
- Test: `D:/Claude/hub/apps/hub-server/src/db/schema.test.ts`

- [ ] **Step 1: Create `apps/hub-server/drizzle.config.ts`**

```ts
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
```

- [ ] **Step 2: Write failing test `src/db/schema.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { users, sessions, auditLog, pairings } from './schema.js';

describe('schema', () => {
  it('users table has expected columns', () => {
    const cols = Object.keys(users);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'email', 'passwordHash', 'name', 'role', 'createdAt', 'lastLoginAt']),
    );
  });

  it('sessions table has token + expiresAt', () => {
    const cols = Object.keys(sessions);
    expect(cols).toEqual(expect.arrayContaining(['id', 'userId', 'token', 'expiresAt', 'createdAt']));
  });

  it('auditLog table has actor + action + payload', () => {
    const cols = Object.keys(auditLog);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'actorUserId', 'action', 'targetType', 'targetId', 'payload', 'createdAt']),
    );
  });

  it('pairings table has pin + expiresAt', () => {
    const cols = Object.keys(pairings);
    expect(cols).toEqual(expect.arrayContaining(['id', 'userId', 'pin', 'expiresAt', 'createdAt']));
  });
});
```

- [ ] **Step 3: Run test, verify FAIL**

```bash
pnpm test src/db/schema.test.ts
```

Expected: FAIL — `Cannot find module './schema.js'`.

- [ ] **Step 4: Implement `src/db/schema.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('sessions_token_idx').on(t.token),
  }),
);

export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const pairings = pgTable(
  'pairings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pin: text('pin').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    pinIdx: uniqueIndex('pairings_pin_idx').on(t.pin),
  }),
);
```

- [ ] **Step 5: Implement `src/db/client.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10 });
  return drizzle(client, { schema });
}
```

- [ ] **Step 6: Implement `src/db/migrate.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadEnv } from '../env.js';

async function main() {
  const env = loadEnv();
  const client = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: '../../ops/migrations' });
  await client.end();
  console.log('migrations applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Run test, verify PASS**

```bash
pnpm test src/db/schema.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 8: Generate initial migration**

```bash
cd D:/Claude/hub/apps/hub-server
pnpm db:gen
```

Expected: `ops/migrations/0000_*.sql` and `ops/migrations/meta/_journal.json` are written.

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat(hub-server): add drizzle schema for users, sessions, audit_log, pairings"
```

---

### Task 7: Database integration test — Testcontainers

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/test/integration/db.test.ts`
- Create: `D:/Claude/hub/apps/hub-server/test/helpers/postgres.ts`

- [ ] **Step 1: Create `test/helpers/postgres.ts`**

```ts
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
```

- [ ] **Step 2: Write failing test `test/integration/db.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { users } from '../../src/db/schema.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('db integration', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  it('inserts and queries a user', async () => {
    const id = uuidv7();
    await pg.db.insert(users).values({
      id,
      email: 'a@b.cz',
      passwordHash: 'x',
      name: 'A',
      role: 'admin',
    });

    const rows = await pg.db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('a@b.cz');
  });
});
```

- [ ] **Step 3: Run test, verify it passes (Docker required)**

```bash
pnpm test test/integration/db.test.ts
```

Expected: PASS — 1 test passes after container start (~30 s).

If Docker is not available locally, mark this test as `it.skip` and run only in CI. (CI has Docker.)

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "test(hub-server): add postgres integration test fixture via testcontainers"
```

---

### Task 8: Argon2id password hashing module

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/src/auth/password.ts`
- Test: `D:/Claude/hub/apps/hub-server/src/auth/password.test.ts`

- [ ] **Step 1: Write failing test `src/auth/password.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, validatePasswordStrength } from './password.js';

describe('password', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct-horse-battery-staple')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('rejects passwords shorter than 12 chars', () => {
    expect(() => validatePasswordStrength('short')).toThrow(/at least 12/);
  });

  it('accepts a strong 12+ char password', () => {
    expect(() => validatePasswordStrength('correcthorse')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth/password.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { hash, verify, Algorithm } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

export function validatePasswordStrength(plain: string): void {
  if (plain.length < 12) {
    throw new Error('Password must be at least 12 characters long');
  }
}
```

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm test src/auth/password.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(hub-server): add argon2id password hashing module"
```

---

### Task 9: Session management — opaque tokens, cookies

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/src/auth/session.ts`
- Create: `D:/Claude/hub/apps/hub-server/src/auth/cookie.ts`
- Test: `D:/Claude/hub/apps/hub-server/src/auth/session.test.ts`

- [ ] **Step 1: Write failing test `src/auth/session.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { users } from '../db/schema.js';
import { startPostgres, type PgFixture } from '../../test/helpers/postgres.js';
import { createSession, lookupSession, deleteSession, generateSessionToken } from './session.js';

describe('session', () => {
  let pg: PgFixture;
  let userId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    userId = uuidv7();
    await pg.db.insert(users).values({
      id: userId,
      email: 's@b.cz',
      passwordHash: 'x',
      name: 'S',
      role: 'member',
    });
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  it('generateSessionToken returns 256-bit base64url', () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(43);
  });

  it('creates and looks up a session', async () => {
    const token = await createSession(pg.db, userId);
    const row = await lookupSession(pg.db, token);
    expect(row?.userId).toBe(userId);
  });

  it('returns null for invalid token', async () => {
    expect(await lookupSession(pg.db, 'nonexistent')).toBeNull();
  });

  it('deleteSession invalidates token', async () => {
    const token = await createSession(pg.db, userId);
    await deleteSession(pg.db, token);
    expect(await lookupSession(pg.db, token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth/session.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = generateSessionToken();
  await db.insert(sessions).values({
    id: uuidv7(),
    userId,
    token,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export interface SessionRow {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

export async function lookupSession(db: Db, token: string): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}
```

- [ ] **Step 4: Implement `src/auth/cookie.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'hub_session';

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
```

- [ ] **Step 5: Run test, verify PASS**

Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(hub-server): add opaque session tokens with httponly cookies"
```

---

### Task 10: Audit log helper

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/src/audit.ts`
- Test: `D:/Claude/hub/apps/hub-server/src/audit.test.ts`

- [ ] **Step 1: Write failing test `src/audit.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { users, auditLog } from './db/schema.js';
import { startPostgres, type PgFixture } from '../test/helpers/postgres.js';
import { writeAudit } from './audit.js';

describe('audit', () => {
  let pg: PgFixture;
  let userId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    userId = uuidv7();
    await pg.db.insert(users).values({
      id: userId,
      email: 'au@b.cz',
      passwordHash: 'x',
      name: 'A',
      role: 'admin',
    });
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  it('writes an audit row with payload', async () => {
    await writeAudit(pg.db, {
      actorUserId: userId,
      action: 'user.login',
      targetType: 'user',
      targetId: userId,
      payload: { ip: '127.0.0.1' },
    });

    const rows = await pg.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('user.login');
    expect(rows[0]?.payload).toEqual({ ip: '127.0.0.1' });
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement `src/audit.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { v7 as uuidv7 } from 'uuid';
import type { Db } from './db/client.js';
import { auditLog } from './db/schema.js';

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    id: uuidv7(),
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    payload: entry.payload,
  });
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(hub-server): add audit log helper"
```

---

### Task 11: Auth middleware — `requireUser`, `requireRole`

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/src/middleware/auth.ts`
- Test: `D:/Claude/hub/apps/hub-server/src/middleware/auth.test.ts`

- [ ] **Step 1: Write failing test `src/middleware/auth.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { users } from '../db/schema.js';
import { createSession } from '../auth/session.js';
import { requireUser, requireRole, type AuthEnv } from './auth.js';
import { startPostgres, type PgFixture } from '../../test/helpers/postgres.js';

describe('auth middleware', () => {
  let pg: PgFixture;
  let memberId: string;
  let adminId: string;
  let memberToken: string;
  let adminToken: string;

  beforeAll(async () => {
    pg = await startPostgres();
    memberId = uuidv7();
    adminId = uuidv7();
    await pg.db.insert(users).values([
      { id: memberId, email: 'm@b.cz', passwordHash: 'x', name: 'M', role: 'member' },
      { id: adminId, email: 'a@b.cz', passwordHash: 'x', name: 'A', role: 'admin' },
    ]);
    memberToken = await createSession(pg.db, memberId);
    adminToken = await createSession(pg.db, adminId);
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  function buildTestApp() {
    const app = new Hono<AuthEnv>();
    app.use('*', requireUser(pg.db));
    app.get('/me', (c) => c.json({ userId: c.var.user.id, role: c.var.user.role }));
    app.get('/admin', requireRole('admin'), (c) => c.json({ ok: true }));
    return app;
  }

  it('rejects request without cookie', async () => {
    const res = await buildTestApp().request('/me');
    expect(res.status).toBe(401);
  });

  it('accepts valid session cookie', async () => {
    const res = await buildTestApp().request('/me', {
      headers: { cookie: `hub_session=${memberToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: memberId, role: 'member' });
  });

  it('member is forbidden from admin route', async () => {
    const res = await buildTestApp().request('/admin', {
      headers: { cookie: `hub_session=${memberToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('admin passes admin route', async () => {
    const res = await buildTestApp().request('/admin', {
      headers: { cookie: `hub_session=${adminToken}` },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement `src/middleware/auth.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import type { ApiError, UserRole } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { lookupSession } from '../auth/session.js';
import { SESSION_COOKIE } from '../auth/cookie.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface AuthEnv {
  Variables: {
    user: AuthUser;
  };
}

export function requireUser(db: Db) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) {
      const err: ApiError = { code: 'unauthorized', message: 'No session' };
      return c.json(err, 401);
    }
    const session = await lookupSession(db, token);
    if (!session) {
      const err: ApiError = { code: 'unauthorized', message: 'Invalid or expired session' };
      return c.json(err, 401);
    }
    const rows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    const u = rows[0];
    if (!u || !u.active) {
      const err: ApiError = { code: 'unauthorized', message: 'User not found or inactive' };
      return c.json(err, 401);
    }
    c.set('user', { id: u.id, email: u.email, name: u.name, role: u.role as UserRole });
    await next();
  });
}

export function requireRole(role: UserRole) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const u = c.var.user;
    if (!u || u.role !== role) {
      const err: ApiError = { code: 'forbidden', message: `Role '${role}' required` };
      return c.json(err, 403);
    }
    await next();
  });
}
```

- [ ] **Step 4: Run test, verify PASS**

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(hub-server): add requireUser and requireRole middleware"
```

---

### Task 12: Rate limit middleware (in-memory) for login

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/src/middleware/rate-limit.ts`
- Test: `D:/Claude/hub/apps/hub-server/src/middleware/rate-limit.test.ts`

- [ ] **Step 1: Write failing test `src/middleware/rate-limit.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from './rate-limit.js';

describe('LoginRateLimiter', () => {
  it('allows the first 5 attempts within window', () => {
    const rl = new LoginRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
    for (let i = 0; i < 5; i++) {
      expect(rl.tryConsume('1.1.1.1', 'a@b.cz')).toBe(true);
    }
  });

  it('blocks the 6th attempt within window', () => {
    const rl = new LoginRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
    for (let i = 0; i < 5; i++) rl.tryConsume('1.1.1.1', 'a@b.cz');
    expect(rl.tryConsume('1.1.1.1', 'a@b.cz')).toBe(false);
  });

  it('isolates by ip+email key', () => {
    const rl = new LoginRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
    for (let i = 0; i < 5; i++) rl.tryConsume('1.1.1.1', 'a@b.cz');
    expect(rl.tryConsume('1.1.1.1', 'other@b.cz')).toBe(true);
    expect(rl.tryConsume('2.2.2.2', 'a@b.cz')).toBe(true);
  });

  it('resets after windowMs', () => {
    const rl = new LoginRateLimiter({ max: 2, windowMs: 50 });
    rl.tryConsume('1.1.1.1', 'a@b.cz');
    rl.tryConsume('1.1.1.1', 'a@b.cz');
    expect(rl.tryConsume('1.1.1.1', 'a@b.cz')).toBe(false);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(rl.tryConsume('1.1.1.1', 'a@b.cz')).toBe(true);
        resolve();
      }, 80);
    });
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement `src/middleware/rate-limit.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
export interface RateLimitOptions {
  max: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly opts: RateLimitOptions) {}

  tryConsume(ip: string, email: string): boolean {
    const key = `${ip}|${email.toLowerCase()}`;
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      return true;
    }
    if (bucket.count >= this.opts.max) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  reset(ip: string, email: string): void {
    this.buckets.delete(`${ip}|${email.toLowerCase()}`);
  }
}

export const defaultLoginLimiter = new LoginRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(hub-server): add in-memory login rate limiter (5/15min/ip+email)"
```

---

### Task 13: Auth routes — `/api/auth/{register,login,logout,me}`

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/src/routes/auth.ts`
- Modify: `D:/Claude/hub/apps/hub-server/src/app.ts`
- Test: `D:/Claude/hub/apps/hub-server/test/integration/auth.test.ts`

- [ ] **Step 1: Write failing integration test `test/integration/auth.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { v7 as uuidv7 } from 'uuid';

describe('auth routes', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings CASCADE`);
    // pre-existing user is required because /register is locked behind first-run wizard
    await pg.db.insert(users).values({
      id: uuidv7(),
      email: 'seed@b.cz',
      passwordHash: await hashPassword('seed-password-1234'),
      name: 'Seed',
      role: 'admin',
    });
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('POST /api/auth/register creates a member user', async () => {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@b.cz', password: 'longpassword12', name: 'New' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.role).toBe('member');
    expect(body.user.email).toBe('new@b.cz');
  });

  it('POST /api/auth/login returns 200 + session cookie', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seed@b.cz', password: 'seed-password-1234' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/hub_session=/);
  });

  it('POST /api/auth/login wrong password returns 401', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seed@b.cz', password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me returns current user when authed', async () => {
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seed@b.cz', password: 'seed-password-1234' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const res = await app.request('/api/auth/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe('seed@b.cz');
  });

  it('POST /api/auth/logout invalidates session', async () => {
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seed@b.cz', password: 'seed-password-1234' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    const res = await app.request('/api/auth/me', { headers: { cookie } });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement `src/routes/auth.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { ApiError, UserDTO } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/session.js';
import { setSessionCookie, clearSessionCookie, SESSION_COOKIE } from '../auth/cookie.js';
import { getCookie } from 'hono/cookie';
import { writeAudit } from '../audit.js';
import { defaultLoginLimiter } from '../middleware/rate-limit.js';
import { requireUser, type AuthEnv } from '../middleware/auth.js';

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  name: z.string().min(1).max(120),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

function toDTO(row: typeof users.$inferSelect): UserDTO {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  };
}

export function buildAuthRoutes(db: Db, opts: { secureCookie: boolean }) {
  const app = new Hono<AuthEnv>();

  app.post('/register', async (c) => {
    const parsed = RegisterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = { code: 'validation_error', message: 'Invalid body', details: parsed.error.flatten() };
      return c.json(err, 400);
    }
    try {
      validatePasswordStrength(parsed.data.password);
    } catch (e) {
      const err: ApiError = { code: 'validation_error', message: (e as Error).message };
      return c.json(err, 400);
    }

    const existing = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
    if (existing[0]) {
      const err: ApiError = { code: 'conflict', message: 'Email already registered' };
      return c.json(err, 409);
    }

    const id = uuidv7();
    await db.insert(users).values({
      id,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      name: parsed.data.name,
      role: 'member',
    });
    await writeAudit(db, { actorUserId: id, action: 'user.register', targetType: 'user', targetId: id });
    const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!;
    return c.json({ user: toDTO(row) }, 201);
  });

  app.post('/login', async (c) => {
    const parsed = LoginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = { code: 'validation_error', message: 'Invalid body' };
      return c.json(err, 400);
    }
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!defaultLoginLimiter.tryConsume(ip, parsed.data.email)) {
      const err: ApiError = { code: 'rate_limited', message: 'Too many login attempts' };
      return c.json(err, 429);
    }

    const row = (await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1))[0];
    if (!row || !row.active || !(await verifyPassword(row.passwordHash, parsed.data.password))) {
      const err: ApiError = { code: 'unauthorized', message: 'Invalid email or password' };
      return c.json(err, 401);
    }

    defaultLoginLimiter.reset(ip, parsed.data.email);
    const token = await createSession(db, row.id);
    setSessionCookie(c, token, opts.secureCookie);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));
    await writeAudit(db, { actorUserId: row.id, action: 'user.login', targetType: 'user', targetId: row.id, payload: { ip } });
    return c.json({ user: toDTO({ ...row, lastLoginAt: new Date() }) });
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      await deleteSession(db, token);
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get('/me', requireUser(db), async (c) => {
    const u = c.var.user;
    const row = (await db.select().from(users).where(eq(users.id, u.id)).limit(1))[0]!;
    return c.json(toDTO(row));
  });

  return app;
}
```

- [ ] **Step 4: Update `src/app.ts` to mount auth routes**

Replace the file with:

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from './db/client.js';
import { buildAuthRoutes } from './routes/auth.js';

export interface AppOptions {
  db?: Db;
  skipDb?: boolean;
  secureCookie?: boolean;
}

export function buildApp(opts: AppOptions = {}) {
  const app = new Hono();
  app.use('*', honoLogger());

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  if (opts.db) {
    app.route('/api/auth', buildAuthRoutes(opts.db, { secureCookie: opts.secureCookie ?? false }));
  }

  app.notFound((c) => {
    const err: ApiError = { code: 'not_found', message: 'Route not found' };
    return c.json(err, 404);
  });

  app.onError((err, c) => {
    const body: ApiError = { code: 'internal_error', message: 'Internal server error' };
    if (process.env.NODE_ENV !== 'production') {
      body.details = { stack: err.stack };
    }
    return c.json(body, 500);
  });

  return app;
}
```

- [ ] **Step 5: Run test, verify PASS**

Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(hub-server): add /api/auth register, login, logout, me"
```

---

### Task 14: Setup wizard — `/api/setup/init`

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/src/routes/setup.ts`
- Modify: `D:/Claude/hub/apps/hub-server/src/app.ts`
- Test: `D:/Claude/hub/apps/hub-server/test/integration/setup.test.ts`

- [ ] **Step 1: Write failing test `test/integration/setup.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('setup wizard', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings CASCADE`);
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('creates the root admin when no users exist', async () => {
    const res = await app.request('/api/setup/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root@b.cz', password: 'rootpassword12', name: 'Root' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.role).toBe('admin');
  });

  it('returns 409 when users already exist', async () => {
    await app.request('/api/setup/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root@b.cz', password: 'rootpassword12', name: 'Root' }),
    });
    const res = await app.request('/api/setup/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root2@b.cz', password: 'rootpassword12', name: 'Root2' }),
    });
    expect(res.status).toBe(409);
  });

  it('GET /api/setup/status reports needsSetup', async () => {
    const res = await app.request('/api/setup/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsSetup: true });
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement `src/routes/setup.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { ApiError } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, validatePasswordStrength } from '../auth/password.js';
import { writeAudit } from '../audit.js';

const InitSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  name: z.string().min(1).max(120),
});

async function userCount(db: Db): Promise<number> {
  const r = await db.execute<{ count: string }>(sql`select count(*)::text as count from users`);
  return Number.parseInt(r[0]?.count ?? '0', 10);
}

export function buildSetupRoutes(db: Db) {
  const app = new Hono();

  app.get('/status', async (c) => {
    return c.json({ needsSetup: (await userCount(db)) === 0 });
  });

  app.post('/init', async (c) => {
    if ((await userCount(db)) > 0) {
      const err: ApiError = { code: 'conflict', message: 'Setup already completed' };
      return c.json(err, 409);
    }
    const parsed = InitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = { code: 'validation_error', message: 'Invalid body' };
      return c.json(err, 400);
    }
    try {
      validatePasswordStrength(parsed.data.password);
    } catch (e) {
      const err: ApiError = { code: 'validation_error', message: (e as Error).message };
      return c.json(err, 400);
    }
    const id = uuidv7();
    await db.insert(users).values({
      id,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      name: parsed.data.name,
      role: 'admin',
    });
    await writeAudit(db, { actorUserId: id, action: 'setup.init', targetType: 'user', targetId: id });
    return c.json(
      {
        user: {
          id,
          email: parsed.data.email,
          name: parsed.data.name,
          role: 'admin' as const,
          createdAt: new Date().toISOString(),
          lastLoginAt: null,
        },
      },
      201,
    );
  });

  return app;
}
```

- [ ] **Step 4: Mount in `src/app.ts`** — add `import { buildSetupRoutes } from './routes/setup.js';` and after the auth route mount:

```ts
if (opts.db) {
  app.route('/api/auth', buildAuthRoutes(opts.db, { secureCookie: opts.secureCookie ?? false }));
  app.route('/api/setup', buildSetupRoutes(opts.db));
}
```

- [ ] **Step 5: Run test, verify PASS**

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(hub-server): add first-run /api/setup/init wizard endpoint"
```

---

### Task 15: Readiness probe `/readyz` — DB + MinIO

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/src/storage/minio.ts`
- Modify: `D:/Claude/hub/apps/hub-server/src/app.ts`
- Test: `D:/Claude/hub/apps/hub-server/test/integration/readyz.test.ts`
- Test: `D:/Claude/hub/apps/hub-server/test/helpers/minio.ts`

- [ ] **Step 1: Create `test/helpers/minio.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';
import { Client } from 'minio';

export interface MinioFixture {
  container: StartedMinioContainer;
  client: Client;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop: () => Promise<void>;
}

export async function startMinio(): Promise<MinioFixture> {
  const container = await new MinioContainer('minio/minio:RELEASE.2024-10-13T13-34-11Z').start();
  const endpoint = container.getEndpoint();
  const url = new URL(`http://${endpoint}`);
  const client = new Client({
    endPoint: url.hostname,
    port: Number.parseInt(url.port, 10),
    useSSL: false,
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
  });
  return {
    container,
    client,
    endpoint: `http://${endpoint}`,
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    stop: () => container.stop(),
  };
}
```

- [ ] **Step 2: Write failing test `test/integration/readyz.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createMinioClient } from '../../src/storage/minio.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';
import { startMinio, type MinioFixture } from '../helpers/minio.js';

describe('GET /readyz', () => {
  let pg: PgFixture;
  let mn: MinioFixture;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startPostgres();
    mn = await startMinio();
    const minio = createMinioClient({
      endpoint: mn.endpoint,
      accessKey: mn.accessKey,
      secretKey: mn.secretKey,
      bucket: 'claude-hub-artifacts',
    });
    app = buildApp({ db: pg.db, minio });
  }, 180_000);

  afterAll(async () => {
    await pg.stop();
    await mn.stop();
  });

  it('returns ok when db and minio are reachable', async () => {
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ db: 'ok', minio: 'ok' });
  });
});
```

- [ ] **Step 3: Run test, verify FAIL**

- [ ] **Step 4: Implement `src/storage/minio.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Client } from 'minio';

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface MinioContext {
  client: Client;
  bucket: string;
  ping: () => Promise<void>;
}

export function createMinioClient(cfg: MinioConfig): MinioContext {
  const url = new URL(cfg.endpoint);
  const client = new Client({
    endPoint: url.hostname,
    port: Number.parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10),
    useSSL: url.protocol === 'https:',
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
  });

  return {
    client,
    bucket: cfg.bucket,
    ping: async () => {
      await client.listBuckets();
    },
  };
}
```

- [ ] **Step 5: Update `src/app.ts` to mount `/readyz` and accept minio**

Add to `AppOptions`:

```ts
import type { MinioContext } from './storage/minio.js';

export interface AppOptions {
  db?: Db;
  minio?: MinioContext;
  skipDb?: boolean;
  secureCookie?: boolean;
}
```

And inside `buildApp`, after `/healthz`:

```ts
app.get('/readyz', async (c) => {
  const result: Record<string, string> = {};
  let status = 200;
  if (opts.db) {
    try {
      await opts.db.execute(sql`select 1`);
      result.db = 'ok';
    } catch {
      result.db = 'fail';
      status = 503;
    }
  }
  if (opts.minio) {
    try {
      await opts.minio.ping();
      result.minio = 'ok';
    } catch {
      result.minio = 'fail';
      status = 503;
    }
  }
  return c.json(result, status as 200 | 503);
});
```

Add the import: `import { sql } from 'drizzle-orm';`.

- [ ] **Step 6: Run test, verify PASS**

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat(hub-server): add /readyz with db + minio checks"
```

---

### Task 16: Admin user management — `/api/users/{list,invite,patch,delete}`

**Files:**
- Create: `D:/Claude/hub/apps/hub-server/src/routes/users.ts`
- Modify: `D:/Claude/hub/apps/hub-server/src/app.ts`
- Test: `D:/Claude/hub/apps/hub-server/test/integration/users.test.ts`

- [ ] **Step 1: Write failing test `test/integration/users.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/app.js';
import { users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import { startPostgres, type PgFixture } from '../helpers/postgres.js';

describe('admin users routes', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof buildApp>;
  let adminCookie: string;
  let memberCookie: string;
  let memberId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    app = buildApp({ db: pg.db });
  }, 120_000);

  beforeEach(async () => {
    await pg.db.execute(sql`TRUNCATE users, sessions, audit_log, pairings CASCADE`);
    const adminId = uuidv7();
    memberId = uuidv7();
    const hash = await hashPassword('seed-password-1234');
    await pg.db.insert(users).values([
      { id: adminId, email: 'a@b.cz', passwordHash: hash, name: 'A', role: 'admin' },
      { id: memberId, email: 'm@b.cz', passwordHash: hash, name: 'M', role: 'member' },
    ]);
    adminCookie = `hub_session=${await createSession(pg.db, adminId)}`;
    memberCookie = `hub_session=${await createSession(pg.db, memberId)}`;
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('GET /api/users requires admin (member -> 403)', async () => {
    const res = await app.request('/api/users', { headers: { cookie: memberCookie } });
    expect(res.status).toBe(403);
  });

  it('GET /api/users returns list for admin', async () => {
    const res = await app.request('/api/users', { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(2);
  });

  it('POST /api/users/invite returns invite token', async () => {
    const res = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'invitee@b.cz' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.inviteUrl).toMatch(/\/register\?token=/);
  });

  it('PATCH /api/users/:id changes role', async () => {
    const res = await app.request(`/api/users/${memberId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.role).toBe('admin');
  });

  it('DELETE /api/users/:id deactivates the user', async () => {
    const res = await app.request(`/api/users/${memberId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement `src/routes/users.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { randomBytes } from 'node:crypto';
import type { ApiError, UserDTO, UserRole } from '@claude-hub/shared-types';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireUser, requireRole, type AuthEnv } from '../middleware/auth.js';
import { writeAudit } from '../audit.js';

const InviteSchema = z.object({ email: z.string().email() });
const PatchSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  active: z.boolean().optional(),
});

function toDTO(row: typeof users.$inferSelect): UserDTO {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  };
}

export function buildUsersRoutes(db: Db, opts: { publicUrl: string }) {
  const app = new Hono<AuthEnv>();
  app.use('*', requireUser(db));
  app.use('*', requireRole('admin'));

  app.get('/', async (c) => {
    const rows = await db.select().from(users);
    return c.json({ users: rows.map(toDTO) });
  });

  app.post('/invite', async (c) => {
    const parsed = InviteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = { code: 'validation_error', message: 'Invalid body' };
      return c.json(err, 400);
    }
    const token = randomBytes(24).toString('base64url');
    await writeAudit(db, {
      actorUserId: c.var.user.id,
      action: 'user.invite',
      payload: { email: parsed.data.email, token },
    });
    const inviteUrl = `${opts.publicUrl}/register?token=${token}&email=${encodeURIComponent(parsed.data.email)}`;
    return c.json({ inviteUrl, expiresInDays: 7 }, 201);
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const err: ApiError = { code: 'validation_error', message: 'Invalid body' };
      return c.json(err, 400);
    }
    const update: Partial<typeof users.$inferInsert> = {};
    if (parsed.data.role) update.role = parsed.data.role;
    if (parsed.data.active !== undefined) update.active = parsed.data.active;
    await db.update(users).set(update).where(eq(users.id, id));
    const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!row) {
      const err: ApiError = { code: 'not_found', message: 'User not found' };
      return c.json(err, 404);
    }
    await writeAudit(db, {
      actorUserId: c.var.user.id,
      action: 'user.patch',
      targetType: 'user',
      targetId: id,
      payload: parsed.data as Record<string, unknown>,
    });
    return c.json({ user: toDTO(row) });
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (id === c.var.user.id) {
      const err: ApiError = { code: 'validation_error', message: 'Cannot deactivate self' };
      return c.json(err, 400);
    }
    await db.update(users).set({ active: false }).where(eq(users.id, id));
    await writeAudit(db, {
      actorUserId: c.var.user.id,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
    });
    return c.body(null, 204);
  });

  return app;
}
```

- [ ] **Step 4: Mount in `src/app.ts`**

Add to `AppOptions`:

```ts
publicUrl?: string;
```

And after the setup mount:

```ts
if (opts.db) {
  app.route('/api/users', buildUsersRoutes(opts.db, { publicUrl: opts.publicUrl ?? 'http://localhost:3000' }));
}
```

Add: `import { buildUsersRoutes } from './routes/users.js';`.

- [ ] **Step 5: Run test, verify PASS**

Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(hub-server): add admin /api/users list, invite, patch, delete"
```

---

### Task 17: Wire `main.ts` to use real DB + Minio + cookies

**Files:**
- Modify: `D:/Claude/hub/apps/hub-server/src/main.ts`

- [ ] **Step 1: Replace `src/main.ts`**

```ts
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
  const port = Number.parseInt(portStr ?? '3000', 10);

  serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    logger.info({ port: info.port, host }, 'hub-server listening');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify build succeeds**

```bash
cd D:/Claude/hub/apps/hub-server
pnpm typecheck
pnpm build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add .
git commit -m "feat(hub-server): wire main.ts to real db, minio and env config"
```

---

### Task 18: `apps/dashboard` — Next.js 14 + Tailwind + shadcn/ui

**Files:**
- Create: `D:/Claude/hub/apps/dashboard/package.json`
- Create: `D:/Claude/hub/apps/dashboard/tsconfig.json`
- Create: `D:/Claude/hub/apps/dashboard/next.config.mjs`
- Create: `D:/Claude/hub/apps/dashboard/postcss.config.mjs`
- Create: `D:/Claude/hub/apps/dashboard/tailwind.config.ts`
- Create: `D:/Claude/hub/apps/dashboard/src/app/layout.tsx`
- Create: `D:/Claude/hub/apps/dashboard/src/app/page.tsx`
- Create: `D:/Claude/hub/apps/dashboard/src/app/globals.css`
- Create: `D:/Claude/hub/apps/dashboard/src/lib/api.ts`
- Create: `D:/Claude/hub/apps/dashboard/src/lib/utils.ts`
- Create: `D:/Claude/hub/apps/dashboard/components.json`

- [ ] **Step 1: Create `apps/dashboard/package.json`**

```json
{
  "name": "dashboard",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "start": "next start -p 3001",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@claude-hub/shared-types": "workspace:*",
    "@radix-ui/react-label": "^2.1.0",
    "@radix-ui/react-slot": "^1.1.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "lucide-react": "^0.453.0",
    "next": "^14.2.15",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tailwind-merge": "^2.5.4"
  },
  "devDependencies": {
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "vitest": "^2.1.3"
  }
}
```

- [ ] **Step 2: Create `apps/dashboard/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src/**/*", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `apps/dashboard/next.config.mjs`**

```js
// SPDX-License-Identifier: Apache-2.0
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@claude-hub/shared-types'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.HUB_SERVER_URL ?? 'http://localhost:3000'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 4: Create `apps/dashboard/postcss.config.mjs`**

```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 5: Create `apps/dashboard/tailwind.config.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
      },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 6: Create `apps/dashboard/src/app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --border: 214.3 31.8% 91.4%;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
  }
}

body {
  @apply bg-background text-foreground;
}
```

- [ ] **Step 7: Create `apps/dashboard/src/lib/utils.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 8: Create `apps/dashboard/src/lib/api.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import type { ApiError, UserDTO } from '@claude-hub/shared-types';

const BASE = process.env.HUB_SERVER_URL ?? '';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiError;
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  setupStatus: () => call<{ needsSetup: boolean }>('/api/setup/status'),
  setupInit: (body: { email: string; password: string; name: string }) =>
    call<{ user: UserDTO }>('/api/setup/init', { method: 'POST', body: JSON.stringify(body) }),
  register: (body: { email: string; password: string; name: string }) =>
    call<{ user: UserDTO }>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: { email: string; password: string }) =>
    call<{ user: UserDTO }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => call<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => call<UserDTO>('/api/auth/me'),
};
```

- [ ] **Step 9: Create `apps/dashboard/src/app/layout.tsx`**

```tsx
// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Claude Hub',
  description: 'Self-hosted team marketplace for Claude Code',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 10: Create `apps/dashboard/src/app/page.tsx`**

```tsx
// SPDX-License-Identifier: Apache-2.0
export default function Home() {
  return (
    <main className="container mx-auto p-8">
      <h1 className="text-3xl font-semibold">Claude Hub</h1>
      <p className="mt-2 text-muted-foreground">Welcome — sign in to continue.</p>
    </main>
  );
}
```

- [ ] **Step 11: Create `components.json` (shadcn/ui config)**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/app/globals.css",
    "baseColor": "slate",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils"
  }
}
```

- [ ] **Step 12: Verify build**

```bash
cd D:/Claude/hub/apps/dashboard
pnpm install
pnpm typecheck
pnpm build
```

Expected: build succeeds.

- [ ] **Step 13: Commit**

```bash
git add .
git commit -m "feat(dashboard): scaffold next.js 14 with tailwind and shadcn/ui setup"
```

---

### Task 19: shadcn/ui primitives — Button, Input, Label, Form helpers

**Files:**
- Create: `D:/Claude/hub/apps/dashboard/src/components/ui/button.tsx`
- Create: `D:/Claude/hub/apps/dashboard/src/components/ui/input.tsx`
- Create: `D:/Claude/hub/apps/dashboard/src/components/ui/label.tsx`

- [ ] **Step 1: Create `src/components/ui/button.tsx`**

```tsx
// SPDX-License-Identifier: Apache-2.0
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-slate-900 text-white hover:bg-slate-800',
        outline: 'border border-slate-300 bg-white hover:bg-slate-50',
        ghost: 'hover:bg-slate-100',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 px-3',
        lg: 'h-11 px-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';
```

- [ ] **Step 2: Create `src/components/ui/input.tsx`**

```tsx
// SPDX-License-Identifier: Apache-2.0
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
```

- [ ] **Step 3: Create `src/components/ui/label.tsx`**

```tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn('text-sm font-medium leading-none', className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;
```

- [ ] **Step 4: Verify build**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(dashboard): add shadcn/ui button, input, label primitives"
```

---

### Task 20: Login + Register + Setup pages with server actions

**Files:**
- Create: `D:/Claude/hub/apps/dashboard/src/app/login/page.tsx`
- Create: `D:/Claude/hub/apps/dashboard/src/app/login/actions.ts`
- Create: `D:/Claude/hub/apps/dashboard/src/app/register/page.tsx`
- Create: `D:/Claude/hub/apps/dashboard/src/app/register/actions.ts`
- Create: `D:/Claude/hub/apps/dashboard/src/app/setup/page.tsx`
- Create: `D:/Claude/hub/apps/dashboard/src/app/setup/actions.ts`

- [ ] **Step 1: Create `src/app/login/actions.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
'use server';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export async function loginAction(formData: FormData): Promise<{ error?: string }> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const base = process.env.HUB_SERVER_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body.message ?? 'Login failed' };
  }
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/hub_session=([^;]+)/);
    if (m) {
      cookies().set('hub_session', m[1]!, { httpOnly: true, sameSite: 'lax', path: '/' });
    }
  }
  redirect('/');
}
```

- [ ] **Step 2: Create `src/app/login/page.tsx`**

```tsx
// SPDX-License-Identifier: Apache-2.0
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { loginAction } from './actions';

export default function LoginPage() {
  return (
    <main className="container mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>
      <form action={loginAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" required minLength={12} />
        </div>
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Create `src/app/register/actions.ts`** — same shape as login but POSTs to `/api/auth/register`, also takes `name`.

```ts
// SPDX-License-Identifier: Apache-2.0
'use server';
import { redirect } from 'next/navigation';

export async function registerAction(formData: FormData): Promise<{ error?: string }> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const name = String(formData.get('name') ?? '');
  const base = process.env.HUB_SERVER_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body.message ?? 'Registration failed' };
  }
  redirect('/login');
}
```

- [ ] **Step 4: Create `src/app/register/page.tsx`**

```tsx
// SPDX-License-Identifier: Apache-2.0
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { registerAction } from './actions';

export default function RegisterPage() {
  return (
    <main className="container mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-semibold">Create account</h1>
      <form action={registerAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password (min 12 chars)</Label>
          <Input id="password" name="password" type="password" required minLength={12} />
        </div>
        <Button type="submit" className="w-full">
          Register
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: Create `src/app/setup/actions.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
'use server';
import { redirect } from 'next/navigation';

export async function setupAction(formData: FormData): Promise<{ error?: string }> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const name = String(formData.get('name') ?? '');
  const base = process.env.HUB_SERVER_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/setup/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body.message ?? 'Setup failed' };
  }
  redirect('/login');
}
```

- [ ] **Step 6: Create `src/app/setup/page.tsx`**

```tsx
// SPDX-License-Identifier: Apache-2.0
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setupAction } from './actions';

async function getStatus(): Promise<{ needsSetup: boolean }> {
  const base = process.env.HUB_SERVER_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/setup/status`, { cache: 'no-store' });
  if (!res.ok) return { needsSetup: false };
  return res.json() as Promise<{ needsSetup: boolean }>;
}

export default async function SetupPage() {
  const { needsSetup } = await getStatus();
  if (!needsSetup) {
    redirect('/login');
  }
  return (
    <main className="container mx-auto max-w-sm p-8">
      <h1 className="mb-2 text-2xl font-semibold">Welcome to Claude Hub</h1>
      <p className="mb-6 text-sm text-slate-600">Create the root admin account to continue.</p>
      <form action={setupAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password (min 12 chars)</Label>
          <Input id="password" name="password" type="password" required minLength={12} />
        </div>
        <Button type="submit" className="w-full">
          Create admin
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 7: Build dashboard**

```bash
cd D:/Claude/hub/apps/dashboard
pnpm typecheck
pnpm build
```

Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat(dashboard): add login, register, setup pages with server actions"
```

---

### Task 21: GitHub Actions CI — lint, typecheck, unit, integration

**Files:**
- Create: `D:/Claude/hub/.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm --filter shared-types test
      - run: pnpm --filter dashboard test
      - run: pnpm --filter dashboard build

  hub-server:
    runs-on: ubuntu-latest
    services:
      docker:
        image: docker:dind
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter shared-types build
      - run: pnpm --filter hub-server typecheck
      - run: pnpm --filter hub-server test
        env:
          TESTCONTAINERS_RYUK_DISABLED: 'true'

  e2e:
    needs: [node, hub-server]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter shared-types build
      - run: pnpm --filter hub-server build
      - run: pnpm --filter dashboard build
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm --filter e2e run test
        env:
          TESTCONTAINERS_RYUK_DISABLED: 'true'
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add lint, typecheck, unit, integration, e2e pipeline"
```

---

### Task 22: Playwright E2E smoke — register → login → me

**Files:**
- Create: `D:/Claude/hub/e2e/package.json`
- Create: `D:/Claude/hub/e2e/playwright.config.ts`
- Create: `D:/Claude/hub/e2e/tests/auth-smoke.spec.ts`
- Create: `D:/Claude/hub/e2e/global-setup.ts`

- [ ] **Step 1: Create `e2e/package.json`**

```json
{
  "name": "e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "playwright test",
    "lint": "echo no-op",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0",
    "@testcontainers/minio": "^10.13.2",
    "@testcontainers/postgresql": "^10.13.2",
    "testcontainers": "^10.13.2",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Create `e2e/playwright.config.ts`**

```ts
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
```

- [ ] **Step 3: Create `e2e/global-setup.ts`**

```ts
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
  process.env.E2E_MINIO_ENDPOINT = `http://${minio.getEndpoint()}`;

  const migrator = postgres(pg.getConnectionUri(), { max: 1 });
  await migrate(drizzle(migrator), { migrationsFolder: '../ops/migrations' });
  await migrator.end();
}
```

- [ ] **Step 4: Create `e2e/tests/auth-smoke.spec.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

test('first-run setup, then register, then login, then /api/auth/me', async ({ page, request }) => {
  // Setup wizard
  await page.goto('/setup');
  await page.fill('input[name="name"]', 'Root');
  await page.fill('input[name="email"]', 'root@example.com');
  await page.fill('input[name="password"]', 'rootpassword12');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/login/);

  // Register a member
  await page.goto('/register');
  await page.fill('input[name="name"]', 'Member');
  await page.fill('input[name="email"]', 'member@example.com');
  await page.fill('input[name="password"]', 'memberpassword12');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/login/);

  // Login
  await page.goto('/login');
  await page.fill('input[name="email"]', 'member@example.com');
  await page.fill('input[name="password"]', 'memberpassword12');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/');

  // /api/auth/me reachable with cookie
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'hub_session');
  expect(session).toBeDefined();
  const meRes = await request.get('http://localhost:3000/api/auth/me', {
    headers: { cookie: `hub_session=${session!.value}` },
  });
  expect(meRes.status()).toBe(200);
  expect((await meRes.json()).email).toBe('member@example.com');
});
```

- [ ] **Step 5: Run E2E locally**

```bash
cd D:/Claude/hub
pnpm install
pnpm --filter shared-types build
pnpm --filter hub-server build
pnpm --filter dashboard build
pnpm exec playwright install --with-deps chromium
pnpm --filter e2e run test
```

Expected: smoke test passes.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "test(e2e): add playwright smoke for setup, register, login, me"
```

---

## Self-review checklist

Použij tento checklist po dokončení všech tasků (a author tohoto plánu už ho prošel):

1. **Spec coverage:**
   - First-run wizard → Task 14
   - Register / login / logout / me → Task 13
   - Argon2id (m=64MB, t=3, p=4) → Task 8
   - Opaque tokens, HttpOnly Secure SameSite=Lax cookies → Tasks 9, 17
   - Login rate limit 5/15min/IP+email → Tasks 12, 13
   - RBAC `requireRole('admin')` → Task 11
   - Audit log helper → Tasks 10, 13, 14, 16
   - User mgmt (list, invite, patch, delete) admin only → Task 16
   - Postgres schema (users, sessions, audit_log, pairings) → Task 6
   - Healthz + readyz (DB + MinIO) → Tasks 5, 15
   - Docker compose: hub-server + Postgres 16 + MinIO + healthchecks → Task 3
   - Migrations via drizzle-kit, config v `apps/hub-server/drizzle.config.ts` → Task 6
   - Logger (pino), error middleware bez stack traces v prod → Tasks 5, 13
   - Next.js 14 App Router shell + login + register + setup wizard → Tasks 18, 20
   - shadcn/ui (button, input, label) + Tailwind → Tasks 18, 19
   - Server actions volající hub-server → Task 20
   - `packages/shared-types` (UserDTO, UserRole, ApiError, …) → Task 4
   - CI: pnpm install + lint + typecheck + unit + integration (Testcontainers) + Playwright smoke → Tasks 21, 22
   - Tooling: eslint, prettier, lint-staged, husky pre-commit, pnpm scripts → Tasks 1, 2

2. **Placeholder scan:** žádné "TBD", "TODO", "implement later" v krocích — všechno je konkrétní kód nebo příkaz.

3. **Type consistency:**
   - `UserDTO`, `UserRole`, `ArtifactType`, `DaemonOS`, `InventoryItem`, `ApiError` — pojmenování shodné s contracts.
   - `users.passwordHash` (camelCase v drizzle) ↔ `password_hash` (DB column) — explicitně mapované přes drizzle.
   - `requireUser`, `requireRole` — používané všude konzistentně.
   - `SESSION_COOKIE = 'hub_session'` — konzistentně mezi server cookie a Playwright assertem.
   - `LoginRateLimiter` — definovaná v Tasku 12, používaná v Tasku 13 jako `defaultLoginLimiter`.

4. **Open questions:**
   - Invite token generuje audit log, ale nemá vlastní tabulku `invitations` — je to vědomé MVP zjednodušení; rozšíření přijde ve v1.1 (z roadmapy). Pokud reviewer chce striktní invitations table už v MVP, upgrade plánu.
