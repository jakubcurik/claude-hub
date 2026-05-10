// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { wssMessageSchema } from '../src/messages.js';

export function buildJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(wssMessageSchema, {
    name: 'WssMessage',
    target: 'jsonSchema7',
  });
  const defs = (schema as { definitions?: Record<string, { oneOf?: unknown; anyOf?: unknown }> })
    .definitions;
  const wm = defs?.WssMessage;
  if (wm && 'oneOf' in wm && wm.oneOf !== undefined) {
    wm.anyOf = wm.oneOf;
    delete wm.oneOf;
  }
  return schema as Record<string, unknown>;
}

export function emitJsonSchema(outPath: string): void {
  const schema = buildJsonSchema();
  writeFileSync(outPath, JSON.stringify(schema, null, 2), 'utf-8');
}
