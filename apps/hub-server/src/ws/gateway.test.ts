// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from './gateway.js';

class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

describe('Gateway', () => {
  let gw: Gateway;
  beforeEach(() => {
    gw = new Gateway();
  });

  it('registers daemon and retrieves socket by daemonId', () => {
    const s = new FakeSocket();
    gw.registerDaemon('d-1', s);
    expect(gw.getDaemonSocket('d-1')).toBe(s);
  });

  it('registers browser session and routes subscribe.local', () => {
    const s = new FakeSocket();
    gw.registerBrowser('sess-1', 'user-1', s);
    gw.subscribeBrowserToDaemon('sess-1', 'd-1');
    const subs = gw.getBrowserSubscribers('d-1');
    expect(subs).toContain(s);
  });

  it('removes daemon and browser on disconnect', () => {
    const ds = new FakeSocket();
    const bs = new FakeSocket();
    gw.registerDaemon('d-2', ds);
    gw.registerBrowser('sess-2', 'user-2', bs);
    gw.subscribeBrowserToDaemon('sess-2', 'd-2');
    gw.disconnectDaemon('d-2');
    gw.disconnectBrowser('sess-2');
    expect(gw.getDaemonSocket('d-2')).toBeUndefined();
    expect(gw.getBrowserSubscribers('d-2')).toHaveLength(0);
  });

  it('broadcastAll sends to every browser', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    gw.registerBrowser('s-a', 'u-a', a);
    gw.registerBrowser('s-b', 'u-b', b);
    gw.broadcastAll({
      type: 'catalog.update',
      id: 'x',
      payload: { artifactId: 'a', slug: 's', type: 'skill', version: '0.1.0' },
    });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });
});
