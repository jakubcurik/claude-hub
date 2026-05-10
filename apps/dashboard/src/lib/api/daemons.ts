// SPDX-License-Identifier: Apache-2.0
import type { DaemonDTO } from '@claude-hub/shared-types';

export async function listDaemons(): Promise<DaemonDTO[]> {
  const res = await fetch('/api/daemons', { credentials: 'include' });
  if (!res.ok) throw new Error(`listDaemons: ${res.status}`);
  const body = (await res.json()) as { daemons: DaemonDTO[] };
  return body.daemons;
}

export interface PairingResponse {
  pin: string;
  pairingId: string;
  expiresAt: string;
}

export async function createPairing(): Promise<PairingResponse> {
  const res = await fetch('/api/daemons/pair', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`createPairing: ${res.status}`);
  return (await res.json()) as PairingResponse;
}
