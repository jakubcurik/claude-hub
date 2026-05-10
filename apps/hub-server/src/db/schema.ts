// SPDX-License-Identifier: Apache-2.0
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

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
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    pinIdx: uniqueIndex('pairings_pin_idx').on(t.pin),
    expiresIdx: index('pairings_expires_idx').on(t.expiresAt),
  }),
);

export const daemons = pgTable(
  'daemons',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hostname: text('hostname').notNull(),
    os: text('os', { enum: ['windows', 'macos', 'linux'] }).notNull(),
    agentVersion: text('agent_version').notNull(),
    tokenHash: text('token_hash').notNull(),
    pairedAt: timestamp('paired_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('daemons_user_id_idx').on(t.userId),
    osCheck: check('daemons_os_check', sql`${t.os} IN ('windows', 'macos', 'linux')`),
  }),
);

export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull(),
    email: text('email'),
    role: text('role', { enum: ['admin', 'member'] })
      .notNull()
      .default('member'),
    invitedByUserId: text('invited_by_user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true, mode: 'date' }),
    redeemedByUserId: text('redeemed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('invitations_token_idx').on(t.token),
    emailIdx: index('invitations_email_idx').on(t.email),
    expiresIdx: index('invitations_expires_idx').on(t.expiresAt),
  }),
);

export const artifactTypeEnum = pgEnum('artifact_type', ['skill', 'plugin', 'command', 'agent']);
export const installStatusEnum = pgEnum('install_status', ['success', 'failed', 'rolled_back']);

export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    type: artifactTypeEnum('type').notNull(),
    description: text('description').notNull().default(''),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    byType: index('artifacts_type_idx').on(t.type),
    byOwner: index('artifacts_owner_idx').on(t.ownerUserId),
  }),
);

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    manifest: jsonb('manifest').notNull(),
    publishedByUserId: text('published_by_user_id')
      .notNull()
      .references(() => users.id),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    deprecated: boolean('deprecated').notNull().default(false),
  },
  (t) => ({
    uqVersion: uniqueIndex('artifact_versions_artifact_version_uq').on(t.artifactId, t.version),
    byPublishedAt: index('artifact_versions_published_at_idx').on(t.publishedAt),
    manifestGin: index('artifact_versions_manifest_gin').using('gin', t.manifest),
  }),
);

export const installEvents = pgTable(
  'install_events',
  {
    id: text('id').primaryKey(),
    daemonId: text('daemon_id')
      .notNull()
      .references(() => daemons.id),
    artifactVersionId: text('artifact_version_id')
      .notNull()
      .references(() => artifactVersions.id),
    installedAt: timestamp('installed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    status: installStatusEnum('status').notNull(),
  },
  (t) => ({
    byDaemon: index('install_events_daemon_idx').on(t.daemonId),
    byVersion: index('install_events_version_idx').on(t.artifactVersionId),
  }),
);
