// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHubSocket } from './use-hub-socket';

class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe('useHubSocket', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('connects, parses messages, reconnects on close with backoff', () => {
    const onMessage = vi.fn();
    renderHook(() => useHubSocket('ws://x', onMessage));
    expect(FakeWS.instances).toHaveLength(1);
    act(() => {
      FakeWS.instances[0]!.open();
    });
    act(() => {
      FakeWS.instances[0]!.message({
        type: 'catalog.update',
        id: '1',
        payload: { artifactId: 'a', slug: 's', type: 'skill', version: '0.1.0' },
      });
    });
    expect(onMessage).toHaveBeenCalledTimes(1);

    act(() => {
      FakeWS.instances[0]!.close();
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(FakeWS.instances).toHaveLength(2);
    act(() => {
      FakeWS.instances[1]!.close();
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(FakeWS.instances).toHaveLength(3);
  });
});
