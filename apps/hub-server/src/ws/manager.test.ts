// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { ConnectionManager, type WSLike } from './manager.js';

class FakeWS implements WSLike {
  sent: string[] = [];
  closed = false;
  send(s: string): void {
    this.sent.push(s);
  }
  close(): void {
    this.closed = true;
  }
}

describe('ConnectionManager', () => {
  it('tracks connect/disconnect/online state', () => {
    const m = new ConnectionManager();
    const ws = new FakeWS();
    expect(m.isOnline('d1')).toBe(false);
    m.connect('d1', ws);
    expect(m.isOnline('d1')).toBe(true);
    m.disconnect('d1');
    expect(m.isOnline('d1')).toBe(false);
    expect(ws.closed).toBe(true);
  });

  it('replacing a connection closes the previous socket', () => {
    const m = new ConnectionManager();
    const a = new FakeWS();
    const b = new FakeWS();
    m.connect('d1', a);
    m.connect('d1', b);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(m.isOnline('d1')).toBe(true);
  });

  it('sendTo writes JSON to a single daemon', () => {
    const m = new ConnectionManager();
    const ws = new FakeWS();
    m.connect('d1', ws);
    const ok = m.sendTo('d1', { type: 'ping', id: 'x', payload: {} });
    expect(ok).toBe(true);
    expect(ws.sent[0]).toContain('"ping"');
  });

  it('sendTo returns false for unknown daemon', () => {
    const m = new ConnectionManager();
    const ok = m.sendTo('nobody', { type: 'ping', id: 'x', payload: {} });
    expect(ok).toBe(false);
  });

  it('broadcast sends to every connected daemon', () => {
    const m = new ConnectionManager();
    const a = new FakeWS();
    const b = new FakeWS();
    m.connect('a', a);
    m.connect('b', b);
    m.broadcast({ type: 'ping', id: 'x', payload: {} });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
  });
});
