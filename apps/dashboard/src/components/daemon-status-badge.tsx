// SPDX-License-Identifier: Apache-2.0
'use client';

interface Props {
  online: boolean;
  hostname: string;
}

export function DaemonStatusBadge({ online, hostname }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${
        online ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'
      }`}
      data-testid="daemon-status-badge"
    >
      <span className={`h-2 w-2 rounded-full ${online ? 'bg-green-500' : 'bg-gray-400'}`} />
      {hostname} — {online ? 'Online' : 'Offline'}
    </span>
  );
}
