// SPDX-License-Identifier: Apache-2.0
'use client';
import { useEffect, useState } from 'react';
import { createPairing } from '../lib/api/daemons';

interface Props {
  open: boolean;
  onClose: () => void;
  publicUrl: string;
}

export function PairDaemonModal({ open, onClose, publicUrl }: Props) {
  const [pin, setPin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPin(null);
    setError(null);
    createPairing()
      .then((r) => setPin(r.pin))
      .catch((e: unknown) => setError(String(e)));
  }, [open]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Pair daemon"
      className="fixed inset-0 flex items-center justify-center bg-black/40"
    >
      <div className="w-[640px] rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">Pair your daemon</h2>
        {error && <p className="mt-2 text-red-600">{error}</p>}
        {pin && (
          <>
            <p className="mt-2 text-sm text-gray-600">Your pin (valid for 5 minutes):</p>
            <p className="my-3 text-center font-mono text-3xl tracking-widest">{pin}</p>

            <h3 className="mt-4 font-medium">1. Install the agent</h3>
            <pre className="mt-2 rounded bg-gray-100 p-3 text-sm">
              <code>{`# macOS
brew install claude-hub-agent

# Linux
curl ${publicUrl}/install.sh | sh

# Windows (PowerShell)
iwr ${publicUrl}/install.ps1 | iex`}</code>
            </pre>

            <h3 className="mt-4 font-medium">2. Run the pair command</h3>
            <pre className="mt-2 rounded bg-gray-100 p-3 text-sm">
              <code>{`claude-hub-agent pair --hub ${publicUrl} --pin ${pin}`}</code>
            </pre>
          </>
        )}
        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className="rounded bg-blue-600 px-4 py-2 text-white">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
