// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCatalogLiveUpdates } from './providers';

describe('useCatalogLiveUpdates', () => {
  it('invalidates artifacts query on catalog.update message', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCatalogLiveUpdates(), { wrapper });
    act(() => {
      result.current.handleMessage({
        type: 'catalog.update',
        id: '1',
        payload: { artifactId: 'a', slug: 's', type: 'skill', version: '0.1.0' },
      });
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['artifacts'] });
  });
});
