// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { parseMessage, makePing, makePong } from './index.js';

describe('wss-protocol', () => {
  it('round-trips ping/pong', () => {
    const ping = makePing('id-1');
    const parsed = parseMessage(JSON.stringify(ping));
    expect(parsed).toEqual({ type: 'ping', id: 'id-1', payload: {} });
    const pong = makePong('id-1');
    expect(pong.type).toBe('pong');
    expect(pong.id).toBe('id-1');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseMessage('not json')).toThrow();
  });

  it('rejects missing type', () => {
    expect(() => parseMessage('{"id":"x"}')).toThrow(/type/);
  });
});
