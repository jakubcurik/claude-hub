// SPDX-License-Identifier: Apache-2.0
export type WSSMessageType =
  | 'ping'
  | 'pong'
  | 'inventory.snapshot'
  | 'inventory.delta'
  | 'job.install'
  | 'job.uninstall'
  | 'job.toggle'
  | 'job.package'
  | 'job.result'
  | 'subscribe.local'
  | 'local.snapshot'
  | 'local.delta'
  | 'catalog.update';

export interface WSSMessage<T = unknown> {
  type: WSSMessageType;
  id: string;
  payload: T;
}

export function makePing(id: string): WSSMessage<Record<string, never>> {
  return { type: 'ping', id, payload: {} };
}

export function makePong(id: string): WSSMessage<Record<string, never>> {
  return { type: 'pong', id, payload: {} };
}

export function parseMessage(raw: string): WSSMessage {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`wss-protocol: invalid JSON: ${(e as Error).message}`);
  }
  if (!obj || typeof obj !== 'object') throw new Error('wss-protocol: not an object');
  const m = obj as Partial<WSSMessage>;
  if (typeof m.type !== 'string') throw new Error('wss-protocol: missing type');
  if (typeof m.id !== 'string') throw new Error('wss-protocol: missing id');
  return { type: m.type as WSSMessageType, id: m.id, payload: m.payload ?? {} };
}
