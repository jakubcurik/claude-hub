// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PairDaemonModal } from '../pair-daemon-modal';

vi.mock('../../lib/api/daemons', () => ({
  createPairing: vi.fn().mockResolvedValue({
    pin: '482913',
    pairingId: 'p1',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }),
}));

describe('PairDaemonModal', () => {
  it('shows pin and per-OS install command after open', async () => {
    render(<PairDaemonModal open={true} onClose={() => {}} publicUrl="https://hub.example" />);
    await waitFor(() => expect(screen.getByText('482913')).toBeInTheDocument());
    expect(screen.getByText(/brew install/)).toBeInTheDocument();
    expect(screen.getByText(/install\.sh/)).toBeInTheDocument();
    expect(screen.getByText(/install\.ps1/)).toBeInTheDocument();
    expect(
      screen.getByText(/claude-hub-agent pair --hub https:\/\/hub\.example --pin 482913/),
    ).toBeInTheDocument();
  });

  it('calls onClose when Done clicked', async () => {
    const onClose = vi.fn();
    render(<PairDaemonModal open={true} onClose={onClose} publicUrl="https://hub.example" />);
    await waitFor(() => screen.getByText('482913'));
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
