// SPDX-License-Identifier: Apache-2.0
'use client';
import { useEffect, useState } from 'react';
import type { DaemonDTO } from '@claude-hub/shared-types';
import { listDaemons } from '../lib/api/daemons';
import { DaemonStatusBadge } from './daemon-status-badge';
import { PairDaemonModal } from './pair-daemon-modal';

interface Props {
  publicUrl: string;
}

export function DaemonStatusBanner({ publicUrl }: Props) {
  const [daemons, setDaemons] = useState<DaemonDTO[] | null>(null);
  const [pairOpen, setPairOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const list = await listDaemons();
        if (alive) setDaemons(list);
      } catch {
        // ignore transient
      }
    };
    void tick();
    const t = setInterval(() => {
      void tick();
    }, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (daemons === null) return <div className="text-sm text-gray-400">Loading…</div>;

  if (daemons.length === 0) {
    return (
      <>
        <div className="rounded border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm">
            Your daemon is not paired yet. Install the agent and run pair to connect.
          </p>
          <button
            onClick={() => setPairOpen(true)}
            className="mt-2 rounded bg-blue-600 px-3 py-1 text-white"
          >
            Pair daemon
          </button>
        </div>
        <PairDaemonModal open={pairOpen} onClose={() => setPairOpen(false)} publicUrl={publicUrl} />
      </>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {daemons.map((d) => (
        <DaemonStatusBadge key={d.id} online={d.online} hostname={d.hostname} />
      ))}
    </div>
  );
}
