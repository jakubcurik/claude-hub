// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InstallButton } from './install-button';

describe('InstallButton', () => {
  it('POSTs to /api/install-request with correct body', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<InstallButton artifactId="a-1" version="0.1.0" daemonId="d-1" />);
    fireEvent.click(screen.getByRole('button', { name: /install/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const calls = fetchMock.mock.calls;
    expect(calls).toHaveLength(1);
    const [, init] = calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      artifactId: 'a-1',
      version: '0.1.0',
      daemonId: 'd-1',
    });
    vi.unstubAllGlobals();
  });

  it('shows error on failure', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'daemon offline' }), { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<InstallButton artifactId="a-1" version="0.1.0" daemonId="d-1" />);
    fireEvent.click(screen.getByRole('button', { name: /install/i }));
    await waitFor(() => expect(screen.getByText(/daemon offline/i)).toBeInTheDocument());
    vi.unstubAllGlobals();
  });
});
