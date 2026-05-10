// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { artifactManifestSchema } from './manifest-schema.js';

describe('artifactManifestSchema', () => {
  it('parses a minimal valid skill manifest', () => {
    const m = artifactManifestSchema.parse({
      schemaVersion: 1,
      name: 'foo',
      type: 'skill',
      description: 'helps with foo',
      typeMeta: {},
    });
    expect(m.name).toBe('foo');
    expect(m.type).toBe('skill');
  });

  it('defaults typeMeta to empty object', () => {
    const m = artifactManifestSchema.parse({
      schemaVersion: 1,
      name: 'foo',
      type: 'skill',
      description: 'helps',
    });
    expect(m.typeMeta).toEqual({});
  });

  it('rejects unknown type', () => {
    expect(() =>
      artifactManifestSchema.parse({
        schemaVersion: 1,
        name: 'foo',
        type: 'mcp',
        description: 'x',
      }),
    ).toThrow();
  });

  it('rejects missing name', () => {
    expect(() =>
      artifactManifestSchema.parse({
        schemaVersion: 1,
        type: 'skill',
        description: 'x',
      }),
    ).toThrow();
  });

  it('rejects empty description', () => {
    expect(() =>
      artifactManifestSchema.parse({
        schemaVersion: 1,
        name: 'foo',
        type: 'skill',
        description: '',
      }),
    ).toThrow();
  });
});
