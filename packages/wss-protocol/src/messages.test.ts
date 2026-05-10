// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { parseMessage } from './messages.js';

describe('wss messages', () => {
  it('parses inventory.snapshot', () => {
    const m = parseMessage({
      type: 'inventory.snapshot',
      id: 'r1',
      payload: {
        items: [{ type: 'skill', slug: 'foo', version: null, path: '/x', enabled: null }],
      },
    });
    expect(m.type).toBe('inventory.snapshot');
  });

  it('parses job.install with required fields', () => {
    const m = parseMessage({
      type: 'job.install',
      id: 'r2',
      payload: {
        requestId: 'req-1',
        artifactVersionId: 'av-1',
        type: 'skill',
        slug: 'foo',
        version: '0.1.0',
        sha256: 'a'.repeat(64),
        downloadUrl: 'https://example/foo.tar.gz',
        targetPath: '~/.claude/skills/foo',
      },
    });
    expect(m.type).toBe('job.install');
  });

  it('parses job.toggle (plugin only flag carrier)', () => {
    const m = parseMessage({
      type: 'job.toggle',
      id: 'r3',
      payload: { requestId: 'rq', artifactId: 'a-1', slug: 'pl', enabled: true },
    });
    expect(m.type).toBe('job.toggle');
  });

  it('parses subscribe.local + local.snapshot + local.delta + catalog.update', () => {
    expect(
      parseMessage({ type: 'subscribe.local', id: 's1', payload: { daemonId: 'd-1' } }).type,
    ).toBe('subscribe.local');
    expect(
      parseMessage({
        type: 'local.snapshot',
        id: 's2',
        payload: { daemonId: 'd-1', items: [] },
      }).type,
    ).toBe('local.snapshot');
    expect(
      parseMessage({
        type: 'local.delta',
        id: 's3',
        payload: { daemonId: 'd-1', added: [], removed: [], modified: [] },
      }).type,
    ).toBe('local.delta');
    expect(
      parseMessage({
        type: 'catalog.update',
        id: 's4',
        payload: { artifactId: 'a-1', slug: 'foo', type: 'skill', version: '0.1.0' },
      }).type,
    ).toBe('catalog.update');
  });

  it('rejects unknown type', () => {
    expect(() => parseMessage({ type: 'job.enable', id: 'x', payload: {} })).toThrow();
  });

  it('rejects job.install missing requestId', () => {
    expect(() =>
      parseMessage({
        type: 'job.install',
        id: 'r4',
        payload: {
          artifactVersionId: 'av-1',
          type: 'skill',
          slug: 'foo',
          version: '0.1.0',
          sha256: 'a'.repeat(64),
          downloadUrl: 'u',
          targetPath: '~/.claude/skills/foo',
        },
      }),
    ).toThrow();
  });
});
