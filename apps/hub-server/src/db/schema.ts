// SPDX-License-Identifier: Apache-2.0
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
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
