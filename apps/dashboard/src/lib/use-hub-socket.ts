// SPDX-License-Identifier: Apache-2.0
'use client';
import { useEffect, useRef, useState } from 'react';
import { parseMessage, type WssMessage } from '@claude-hub/wss-protocol/messages';

export type HubSocketStatus = 'connecting' | 'open' | 'closed';

export function useHubSocket(
  url: string,
  onMessage: (m: WssMessage) => void,
): { status: HubSocketStatus; send: (m: WssMessage) => void } {
  const [status, setStatus] = useState<HubSocketStatus>('connecting');
  const sendRef = useRef<(m: WssMessage) => void>(() => {});

  useEffect(() => {
    let attempt = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let currentSocket: WebSocket | null = null;

    const connect = () => {
      const s = new WebSocket(url);
      currentSocket = s;
      setStatus('connecting');
      s.onopen = () => {
        setStatus('open');
        attempt = 0;
      };
      s.onmessage = (e) => {
        try {
          onMessage(parseMessage(JSON.parse(e.data)));
        } catch {
          // ignore parse errors
        }
      };
      s.onclose = () => {
        setStatus('closed');
        if (!cancelled) {
          const delay = Math.min(10_000, 100 * 2 ** attempt);
          attempt += 1;
          timer = setTimeout(connect, delay);
        }
      };
      sendRef.current = (m) => {
        if (s.readyState === 1) s.send(JSON.stringify(m));
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      currentSocket?.close();
    };
  }, [url, onMessage]);

  return { status, send: (m) => sendRef.current(m) };
}
