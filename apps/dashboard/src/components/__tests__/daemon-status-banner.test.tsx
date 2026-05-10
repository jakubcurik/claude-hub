// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DaemonStatusBanner } from '../daemon-status-banner';

const listDaemonsMock = vi.fn();
vi.mock('../../lib/api/daemons', () => ({
  listDaemons: () => listDaemonsMock(),
  createPairing: vi
    .fn()
    .mockResolvedValue({ pin: '000000', pairingId: 'p', expiresAt: new Date().toISOString() }),
}));

describe('DaemonStatusBanner', () => {
  it('shows Pair daemon CTA when no daemons', async () => {
    listDaemonsMock.mockResolvedValueOnce([]);
    render(<DaemonStatusBanner publicUrl="https://hub.example" />);
    await waitFor(() => expect(screen.getByText(/not paired yet/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /pair daemon/i })).toBeInTheDocument();
  });

  it('shows online badge when at least one daemon is online', async () => {
    listDaemonsMock.mockResolvedValueOnce([
      {
        id: 'd1',
        hostname: 'mac',
        os: 'macos',
        online: true,
        agentVersion: '0.1.0',
        pairedAt: '',
        lastSeenAt: '',
      },
    ]);
    render(<DaemonStatusBanner publicUrl="https://hub.example" />);
    await waitFor(() => expect(screen.getByText(/online/i)).toBeInTheDocument());
  });
});
