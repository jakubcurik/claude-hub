// SPDX-License-Identifier: Apache-2.0
'use client';
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WssMessage } from '@claude-hub/wss-protocol/messages';

export function useCatalogLiveUpdates() {
  const qc = useQueryClient();
  const handleMessage = useCallback(
    (m: WssMessage) => {
      if (m.type === 'catalog.update') {
        qc.invalidateQueries({ queryKey: ['artifacts'] });
      }
    },
    [qc],
  );
  return { handleMessage };
}
