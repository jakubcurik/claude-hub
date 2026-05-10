// SPDX-License-Identifier: Apache-2.0
import type { UUID, UserRole } from './users.js';

export interface InvitationDTO {
  id: UUID;
  email: string | null;
  role: UserRole;
  invitedByUserId: UUID;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedByUserId: UUID | null;
  createdAt: string;
}
