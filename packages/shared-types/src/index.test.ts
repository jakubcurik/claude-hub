// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type {
  UserDTO,
  UserRole,
  ArtifactType,
  DaemonOS,
  InventoryItem,
  ApiError,
} from './index.js';

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
