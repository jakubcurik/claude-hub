// SPDX-License-Identifier: Apache-2.0
import type { WssMessage } from '@claude-hub/wss-protocol/messages';

export interface WSLike {
  send(data: string): void;
  readyState: number;
}

export class Gateway {
  private daemons = new Map<string, WSLike>();
  private browsers = new Map<string, { userId: string; socket: WSLike }>();
  private subscriptions = new Map<string, Set<string>>();

  registerDaemon(daemonId: string, socket: WSLike): void {
    this.daemons.set(daemonId, socket);
  }

  getDaemonSocket(daemonId: string): WSLike | undefined {
    return this.daemons.get(daemonId);
  }

  disconnectDaemon(daemonId: string): void {
    this.daemons.delete(daemonId);
  }

  registerBrowser(sessionId: string, userId: string, socket: WSLike): void {
    this.browsers.set(sessionId, { userId, socket });
  }

  disconnectBrowser(sessionId: string): void {
    this.browsers.delete(sessionId);
    for (const subs of this.subscriptions.values()) subs.delete(sessionId);
  }

  subscribeBrowserToDaemon(sessionId: string, daemonId: string): void {
    let set = this.subscriptions.get(daemonId);
    if (!set) {
      set = new Set();
      this.subscriptions.set(daemonId, set);
    }
    set.add(sessionId);
  }

  getBrowserSubscribers(daemonId: string): WSLike[] {
    const sessIds = this.subscriptions.get(daemonId);
    if (!sessIds) return [];
    const out: WSLike[] = [];
    for (const sid of sessIds) {
      const b = this.browsers.get(sid);
      if (b) out.push(b.socket);
    }
    return out;
  }

  broadcastToSubscribers(daemonId: string, msg: WssMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.getBrowserSubscribers(daemonId)) {
      if (s.readyState === 1) s.send(data);
    }
  }

  broadcastAll(msg: WssMessage): void {
    const data = JSON.stringify(msg);
    for (const { socket } of this.browsers.values()) {
      if (socket.readyState === 1) socket.send(data);
    }
  }
}

export const gateway = new Gateway();
