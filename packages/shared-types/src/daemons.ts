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
