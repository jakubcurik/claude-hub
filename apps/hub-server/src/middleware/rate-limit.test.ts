// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from './rate-limit.js';

describe('LoginRateLimiter', () => {
  it('allows the first 5 attempts within window', () => {
    const rl = new LoginRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
    for (let i = 0; i < 5; i++) {
      expect(rl.tryConsume('1.1.1.1', 'a@b.cz')).toBe(true);
    }
  });

  it('blocks the 6th attempt within window', () => {
    const rl = new LoginRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
    for (let i = 0; i < 5; i++) rl.tryConsume('1.1.1.1', 'a@b.cz');
    expect(rl.tryConsume('1.1.1.1', 'a@b.cz')).toBe(false);
  });

  it('isolates by ip+email key', () => {
    const rl = new LoginRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
    for (let i = 0; i < 5; i++) rl.tryConsume('1.1.1.1', 'a@b.cz');
    expect(rl.tryConsume('1.1.1.1', 'other@b.cz')).toBe(true);
    expect(rl.tryConsume('2.2.2.2', 'a@b.cz')).toBe(true);
  });

  it('resets after windowMs', () => {
    const rl = new LoginRateLimiter({ max: 2, windowMs: 50 });
    rl.tryConsume('1.1.1.1', 'a@b.cz');
    rl.tryConsume('1.1.1.1', 'a@b.cz');
    expect(rl.tryConsume('1.1.1.1', 'a@b.cz')).toBe(false);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(rl.tryConsume('1.1.1.1', 'a@b.cz')).toBe(true);
        resolve();
      }, 80);
    });
  });
});
