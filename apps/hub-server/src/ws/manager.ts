// SPDX-License-Identifier: Apache-2.0
import type { WSSMessage } from '@claude-hub/wss-protocol';

export interface WSLike {
  send(data: string): void;
  close(): void;
}

export class ConnectionManager {
  private readonly conns = new Map<string, WSLike>();

  connect(daemonId: string, ws: WSLike): void {
    const prev = this.conns.get(daemonId);
    if (prev) prev.close();
    this.conns.set(daemonId, ws);
  }

  disconnect(daemonId: string): void {
    const ws = this.conns.get(daemonId);
    if (ws) ws.close();
    this.conns.delete(daemonId);
  }

  isOnline(daemonId: string): boolean {
    return this.conns.has(daemonId);
  }

  sendTo(daemonId: string, msg: WSSMessage): boolean {
    const ws = this.conns.get(daemonId);
    if (!ws) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  broadcast(msg: WSSMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.conns.values()) ws.send(data);
  }
}

export const connectionManager = new ConnectionManager();
