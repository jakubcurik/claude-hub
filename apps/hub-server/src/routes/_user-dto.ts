// SPDX-License-Identifier: Apache-2.0
import type { UserDTO } from '@claude-hub/shared-types';
import type { users } from '../db/schema.js';

export function toUserDTO(row: typeof users.$inferSelect): UserDTO {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  };
}
