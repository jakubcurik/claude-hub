// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { users, sessions, auditLog, pairings, invitations, daemons } from './schema.js';

describe('schema', () => {
  it('users table has expected columns', () => {
    const cols = Object.keys(users);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'email',
        'passwordHash',
        'name',
        'role',
        'createdAt',
        'lastLoginAt',
      ]),
    );
  });

  it('sessions table has token + expiresAt', () => {
    const cols = Object.keys(sessions);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'userId', 'token', 'expiresAt', 'createdAt']),
    );
  });

  it('auditLog table has actor + action + payload', () => {
    const cols = Object.keys(auditLog);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'actorUserId',
        'action',
        'targetType',
        'targetId',
        'payload',
        'createdAt',
      ]),
    );
  });

  it('pairings table has pin + expiresAt', () => {
    const cols = Object.keys(pairings);
    expect(cols).toEqual(expect.arrayContaining(['id', 'userId', 'pin', 'expiresAt', 'createdAt']));
  });

  it('pairings has expected columns', () => {
    const cols = Object.keys(pairings as unknown as Record<string, unknown>);
    for (const c of ['id', 'pin', 'userId', 'expiresAt', 'consumedAt']) {
      expect(cols).toContain(c);
    }
  });

  it('daemons has expected columns', () => {
    const cols = Object.keys(daemons as unknown as Record<string, unknown>);
    for (const c of [
      'id',
      'userId',
      'hostname',
      'os',
      'agentVersion',
      'tokenHash',
      'pairedAt',
      'lastSeenAt',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('invitations table has token + email + redemption fields', () => {
    const cols = Object.keys(invitations);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'token',
        'email',
        'role',
        'invitedByUserId',
        'expiresAt',
        'redeemedAt',
        'redeemedByUserId',
        'createdAt',
      ]),
    );
  });
});
