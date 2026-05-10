// SPDX-License-Identifier: Apache-2.0
import { hash, verify } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  algorithm: 2, // Algorithm.Argon2id — numeric literal avoids const-enum import under isolatedModules
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

export function validatePasswordStrength(plain: string): void {
  if (plain.length < 12) {
    throw new Error('Password must be at least 12 characters long');
  }
}

let DUMMY_HASH_PROMISE: Promise<string> | undefined;
async function getDummyHash(): Promise<string> {
  if (!DUMMY_HASH_PROMISE) {
    DUMMY_HASH_PROMISE = hash('dummy-equalizer-input', ARGON2_OPTIONS);
  }
  return DUMMY_HASH_PROMISE;
}

export async function equalizeVerifyCost(plain: string): Promise<void> {
  const dummy = await getDummyHash();
  await verify(dummy, plain).catch(() => undefined);
}
