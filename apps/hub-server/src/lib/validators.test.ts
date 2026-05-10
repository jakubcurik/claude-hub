// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { slugSchema, semverSchema, sha256Schema, artifactTypeSchema } from './validators.js';

describe('validators', () => {
  it('accepts valid slugs', () => {
    expect(slugSchema.parse('my-skill')).toBe('my-skill');
    expect(slugSchema.parse('a')).toBe('a');
    expect(slugSchema.parse('a-b-c-1-2-3')).toBe('a-b-c-1-2-3');
  });

  it('rejects invalid slugs', () => {
    expect(() => slugSchema.parse('My_Skill')).toThrow();
    expect(() => slugSchema.parse('-foo')).toThrow();
    expect(() => slugSchema.parse('foo bar')).toThrow();
    expect(() => slugSchema.parse('a'.repeat(65))).toThrow();
  });

  it('accepts strict MAJOR.MINOR.PATCH semver only', () => {
    expect(semverSchema.parse('1.0.0')).toBe('1.0.0');
    expect(() => semverSchema.parse('1.0')).toThrow();
    expect(() => semverSchema.parse('1.0.0-rc.1')).toThrow();
    expect(() => semverSchema.parse('v1.0.0')).toThrow();
  });

  it('accepts 64-hex sha256', () => {
    expect(sha256Schema.parse('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => sha256Schema.parse('abc')).toThrow();
    expect(() => sha256Schema.parse('Z'.repeat(64))).toThrow();
  });

  it('accepts the four artifact types', () => {
    for (const t of ['skill', 'plugin', 'command', 'agent'] as const) {
      expect(artifactTypeSchema.parse(t)).toBe(t);
    }
    expect(() => artifactTypeSchema.parse('mcp')).toThrow();
  });
});
