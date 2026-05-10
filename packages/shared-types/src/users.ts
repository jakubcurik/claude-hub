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
