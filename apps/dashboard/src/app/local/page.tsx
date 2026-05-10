// SPDX-License-Identifier: Apache-2.0
'use client';
import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { DaemonDTO } from '@claude-hub/shared-types';
import type { InventoryItem, WssMessage } from '@claude-hub/wss-protocol/messages';
import { useHubSocket } from '@/lib/use-hub-socket';
import { listDaemons } from '@/lib/api/daemons';
import { InventoryTable } from '@/components/local/inventory-table';
import { PublishDialog } from '@/components/local/publish-dialog';

const queryClient = new QueryClient();

function applyDelta(
  prev: InventoryItem[],
  delta: {
    added: InventoryItem[];
    removed: { type: string; slug: string }[];
    modified: InventoryItem[];
  },
): InventoryItem[] {
  const removedKeys = new Set(delta.removed.map((r) => `${r.type}:${r.slug}`));
  const modifiedMap = new Map(delta.modified.map((m) => [`${m.type}:${m.slug}`, m]));
  const next: InventoryItem[] = [];
  for (const item of prev) {
    const key = `${item.type}:${item.slug}`;
    if (removedKeys.has(key)) continue;
    next.push(modifiedMap.get(key) ?? item);
  }
  for (const a of delta.added) next.push(a);
  return next;
}

function LocalPageInner() {
  const daemonsQuery = useQuery({ queryKey: ['daemons'], queryFn: listDaemons });
  const daemons: DaemonDTO[] = daemonsQuery.data ?? [];
  const [selectedDaemonId, setSelectedDaemonId] = useState<string | null>(null);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [publishItem, setPublishItem] = useState<InventoryItem | null>(null);

  useEffect(() => {
    if (!selectedDaemonId && daemons[0]) setSelectedDaemonId(daemons[0].id);
  }, [daemons, selectedDaemonId]);

  const wsUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/dashboard`;
  }, []);

  const { status, send } = useHubSocket(wsUrl, (m: WssMessage) => {
    if (m.type === 'local.snapshot' && m.payload.daemonId === selectedDaemonId) {
      setItems(m.payload.items);
    } else if (m.type === 'local.delta' && m.payload.daemonId === selectedDaemonId) {
      setItems((prev) => applyDelta(prev, m.payload));
    }
  });

  useEffect(() => {
    if (status === 'open' && selectedDaemonId) {
      setItems([]);
      send({
        type: 'subscribe.local',
        id: crypto.randomUUID(),
        payload: { daemonId: selectedDaemonId },
      });
    }
  }, [status, selectedDaemonId, send]);

  return (
    <main className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">Local artifacts</h1>
      <div className="flex items-center gap-3 text-sm">
        <label htmlFor="daemon-select">Daemon:</label>
        <select
          id="daemon-select"
          className="rounded border border-slate-300 px-2 py-1"
          value={selectedDaemonId ?? ''}
          onChange={(e) => setSelectedDaemonId(e.target.value || null)}
        >
          <option value="">— select —</option>
          {daemons.map((d) => (
            <option key={d.id} value={d.id}>
              {d.hostname} ({d.os})
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">socket: {status}</span>
      </div>
      {selectedDaemonId ? (
        <InventoryTable items={items} onPublish={(i) => setPublishItem(i)} />
      ) : (
        <p className="text-sm text-muted-foreground">Select a daemon to view local artifacts.</p>
      )}
      {selectedDaemonId && (
        <PublishDialog
          daemonId={selectedDaemonId}
          item={publishItem}
          open={publishItem !== null}
          onOpenChange={(o) => {
            if (!o) setPublishItem(null);
          }}
        />
      )}
    </main>
  );
}

export default function LocalPage() {
  return (
    <QueryClientProvider client={queryClient}>
      <LocalPageInner />
    </QueryClientProvider>
  );
}
