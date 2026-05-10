// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, validatePasswordStrength } from './password.js';

describe('password', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct-horse-battery-staple')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('rejects passwords shorter than 12 chars', () => {
    expect(() => validatePasswordStrength('short')).toThrow(/at least 12/);
  });

  it('accepts a strong 12+ char password', () => {
    expect(() => validatePasswordStrength('correcthorse')).not.toThrow();
  });
});
