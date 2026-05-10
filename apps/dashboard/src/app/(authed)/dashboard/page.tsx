// SPDX-License-Identifier: Apache-2.0
import { DaemonStatusBanner } from '@/components/daemon-status-banner';

export default function DashboardPage() {
  const publicUrl = process.env.NEXT_PUBLIC_HUB_URL ?? '';
  return (
    <main className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <DaemonStatusBanner publicUrl={publicUrl} />
    </main>
  );
}
