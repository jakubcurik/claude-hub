// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';
import type { Gateway } from './gateway.js';

type JobResult = { ok: boolean; error?: string; data?: Record<string, unknown> };

const pending = new Map<
  string,
  { resolve: (r: JobResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();

type SendableJobType = 'job.install' | 'job.package' | 'job.toggle' | 'job.uninstall';

export function sendJob(
  gw: Gateway,
  daemonId: string,
  type: SendableJobType,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<JobResult> {
  const sock = gw.getDaemonSocket(daemonId);
  if (!sock) return Promise.reject(new Error('daemon offline'));
  const requestId = nanoid();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('job timeout'));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    sock.send(JSON.stringify({ type, id: nanoid(), payload: { requestId, ...payload } }));
  });
}

export function resolveJob(requestId: string, result: JobResult): void {
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  p.resolve(result);
}

export function rejectAllJobsForDaemon(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

/** test-only: drop pending state between unit tests */
export function __resetJobsForTests(): void {
  for (const [, p] of pending) clearTimeout(p.timer);
  pending.clear();
}
