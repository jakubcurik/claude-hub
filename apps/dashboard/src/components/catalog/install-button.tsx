// SPDX-License-Identifier: Apache-2.0
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function InstallButton({
  artifactId,
  version,
  daemonId,
}: {
  artifactId: string;
  version: string;
  daemonId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/install-request', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifactId, version, daemonId }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(body.error ?? body.message ?? `HTTP ${r.status}`);
      }
      setDone(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button onClick={install} disabled={busy || done}>
        {done ? 'Installed' : busy ? 'Installing…' : 'Install'}
      </Button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
