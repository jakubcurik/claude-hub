// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DaemonStatusBadge } from '../daemon-status-badge';

describe('DaemonStatusBadge', () => {
  it('renders Online when online=true', () => {
    render(<DaemonStatusBadge online={true} hostname="mac-studio" />);
    expect(screen.getByText(/online/i)).toBeInTheDocument();
    expect(screen.getByText(/mac-studio/)).toBeInTheDocument();
  });

  it('renders Offline when online=false', () => {
    render(<DaemonStatusBadge online={false} hostname="mac-studio" />);
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });
});
