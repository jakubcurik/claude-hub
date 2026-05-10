// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Gateway } from './gateway.js';
import { sendJob, resolveJob, __resetJobsForTests } from './jobs.js';

class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  send(d: string) {
    this.sent.push(d);
  }
}

describe('sendJob / resolveJob', () => {
  let gw: Gateway;
  let sock: FakeSocket;

  beforeEach(() => {
    __resetJobsForTests();
    gw = new Gateway();
    sock = new FakeSocket();
    gw.registerDaemon('d-1', sock);
  });

  it('sends a job and resolves on matching job.result', async () => {
    const p = sendJob(gw, 'd-1', 'job.install', {
      artifactVersionId: 'av-1',
      sha256: 'a'.repeat(64),
    });
    expect(sock.sent).toHaveLength(1);
    const sent = JSON.parse(sock.sent[0]!);
    expect(sent.type).toBe('job.install');
    const requestId: string = sent.payload.requestId;
    resolveJob(requestId, { ok: true, data: { extracted: true } });
    await expect(p).resolves.toEqual({ ok: true, data: { extracted: true } });
  });

  it('rejects when daemon is offline', async () => {
    await expect(sendJob(gw, 'unknown', 'job.install', {})).rejects.toThrow(/daemon offline/);
  });

  it('rejects after timeout', async () => {
    vi.useFakeTimers();
    const p = sendJob(gw, 'd-1', 'job.install', {}, 1000);
    vi.advanceTimersByTime(1100);
    await expect(p).rejects.toThrow(/job timeout/);
    vi.useRealTimers();
  });
});
