// SPDX-License-Identifier: Apache-2.0

export interface ConnectionManager {
  isOnline(daemonId: string): boolean;
  disconnect(daemonId: string): void;
}

class StubConnectionManager implements ConnectionManager {
  isOnline(_daemonId: string): boolean {
    return false;
  }
  disconnect(_daemonId: string): void {
    // no-op until Task 19 wires real WS connections
  }
}

export const connectionManager: ConnectionManager = new StubConnectionManager();
