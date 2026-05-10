// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitJsonSchema } from './emit-jsonschema.js';

describe('emitJsonSchema', () => {
  it('writes a JSON Schema file with all 13 message types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wss-'));
    const out = join(dir, 'schema.json');
    emitJsonSchema(out);
    const schema = JSON.parse(readFileSync(out, 'utf-8'));
    const types: string[] = schema.definitions.WssMessage.anyOf.map(
      (variant: { properties: { type: { const: string } } }) => variant.properties.type.const,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'inventory.snapshot',
        'inventory.delta',
        'job.result',
        'pong',
        'job.install',
        'job.uninstall',
        'job.toggle',
        'job.package',
        'ping',
        'subscribe.local',
        'local.snapshot',
        'local.delta',
        'catalog.update',
      ]),
    );
  });
});
