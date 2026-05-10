// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from './gateway.js';
import { handleDaemonMessage, getDaemonInventory, clearDaemonInventory } from './inventory.js';

class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  send(d: string) {
    this.sent.push(d);
  }
}

describe('inventory broadcast', () => {
  let gw: Gateway;
  beforeEach(() => {
    gw = new Gateway();
    clearDaemonInventory('d-1');
    clearDaemonInventory('d-2');
  });

  it('caches snapshot and broadcasts local.snapshot to subscribers', () => {
    const browser = new FakeSocket();
    gw.registerBrowser('s1', 'u1', browser);
    gw.subscribeBrowserToDaemon('s1', 'd-1');
    handleDaemonMessage(gw, 'd-1', {
      type: 'inventory.snapshot',
      id: 'i1',
      payload: {
        items: [{ type: 'skill', slug: 'foo', version: null, path: '/x', enabled: null }],
      },
    });
    expect(browser.sent).toHaveLength(1);
    const m = JSON.parse(browser.sent[0]!);
    expect(m.type).toBe('local.snapshot');
    expect(m.payload.daemonId).toBe('d-1');
    expect(getDaemonInventory('d-1')).toHaveLength(1);
  });

  it('applies delta and broadcasts local.delta', () => {
    const browser = new FakeSocket();
    gw.registerBrowser('s1', 'u1', browser);
    gw.subscribeBrowserToDaemon('s1', 'd-2');
    handleDaemonMessage(gw, 'd-2', {
      type: 'inventory.snapshot',
      id: 'i1',
      payload: { items: [] },
    });
    handleDaemonMessage(gw, 'd-2', {
      type: 'inventory.delta',
      id: 'i2',
      payload: {
        added: [{ type: 'skill', slug: 'bar', version: null, path: '/y', enabled: null }],
        removed: [],
        modified: [],
      },
    });
    expect(browser.sent).toHaveLength(2);
    const m2 = JSON.parse(browser.sent[1]!);
    expect(m2.type).toBe('local.delta');
    expect(m2.payload.added).toHaveLength(1);
    expect(getDaemonInventory('d-2')).toHaveLength(1);
  });
});
