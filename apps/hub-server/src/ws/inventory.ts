// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';
import type { Gateway } from './gateway.js';
import type { InventoryItem, WssMessage } from '@claude-hub/wss-protocol/messages';

const daemonInventory = new Map<string, InventoryItem[]>();

export function getDaemonInventory(daemonId: string): InventoryItem[] {
  return daemonInventory.get(daemonId) ?? [];
}

export function clearDaemonInventory(daemonId: string): void {
  daemonInventory.delete(daemonId);
}

export function handleDaemonMessage(gw: Gateway, daemonId: string, msg: WssMessage): void {
  if (msg.type === 'inventory.snapshot') {
    daemonInventory.set(daemonId, msg.payload.items);
    gw.broadcastToSubscribers(daemonId, {
      type: 'local.snapshot',
      id: nanoid(),
      payload: { daemonId, items: msg.payload.items },
    });
  } else if (msg.type === 'inventory.delta') {
    const cur = daemonInventory.get(daemonId) ?? [];
    const removedKeys = new Set(msg.payload.removed.map((r) => `${r.type}:${r.slug}`));
    const filtered = cur.filter((i) => !removedKeys.has(`${i.type}:${i.slug}`));
    const modIndex = new Map(msg.payload.modified.map((m) => [`${m.type}:${m.slug}`, m]));
    const merged = filtered.map((i) => modIndex.get(`${i.type}:${i.slug}`) ?? i);
    const next = [...merged, ...msg.payload.added];
    daemonInventory.set(daemonId, next);
    gw.broadcastToSubscribers(daemonId, {
      type: 'local.delta',
      id: nanoid(),
      payload: { daemonId, ...msg.payload },
    });
  }
}
