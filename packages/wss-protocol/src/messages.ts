// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const artifactTypeWireSchema = z.enum(['skill', 'plugin', 'command', 'agent']);

export const inventoryItemSchema = z.object({
  type: artifactTypeWireSchema,
  slug: z.string(),
  version: z.string().nullable(),
  path: z.string(),
  enabled: z.boolean().nullable(),
  publishedAs: z.object({ artifactId: z.string(), version: z.string() }).optional(),
});

export const wssMessageSchema = z.discriminatedUnion('type', [
  // Daemon → Hub
  z.object({
    type: z.literal('inventory.snapshot'),
    id: z.string(),
    payload: z.object({ items: z.array(inventoryItemSchema) }),
  }),
  z.object({
    type: z.literal('inventory.delta'),
    id: z.string(),
    payload: z.object({
      added: z.array(inventoryItemSchema).default([]),
      removed: z.array(z.object({ type: artifactTypeWireSchema, slug: z.string() })).default([]),
      modified: z.array(inventoryItemSchema).default([]),
    }),
  }),
  z.object({
    type: z.literal('job.result'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      data: z.record(z.unknown()).optional(),
    }),
  }),
  z.object({ type: z.literal('pong'), id: z.string(), payload: z.object({}) }),

  // Hub → Daemon
  z.object({
    type: z.literal('job.install'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      artifactVersionId: z.string(),
      type: artifactTypeWireSchema,
      slug: z.string(),
      version: z.string(),
      sha256: z.string(),
      downloadUrl: z.string(),
      targetPath: z.string(),
    }),
  }),
  z.object({
    type: z.literal('job.uninstall'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      artifactId: z.string(),
      slug: z.string(),
      type: artifactTypeWireSchema,
    }),
  }),
  z.object({
    type: z.literal('job.toggle'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      artifactId: z.string(),
      slug: z.string(),
      enabled: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('job.package'),
    id: z.string(),
    payload: z.object({
      requestId: z.string(),
      slug: z.string(),
      type: artifactTypeWireSchema,
      version: z.string(),
      description: z.string(),
      sourcePath: z.string(),
    }),
  }),
  z.object({ type: z.literal('ping'), id: z.string(), payload: z.object({}) }),

  // Dashboard ↔ Hub
  z.object({
    type: z.literal('subscribe.local'),
    id: z.string(),
    payload: z.object({ daemonId: z.string() }),
  }),
  z.object({
    type: z.literal('local.snapshot'),
    id: z.string(),
    payload: z.object({
      daemonId: z.string(),
      items: z.array(inventoryItemSchema),
    }),
  }),
  z.object({
    type: z.literal('local.delta'),
    id: z.string(),
    payload: z.object({
      daemonId: z.string(),
      added: z.array(inventoryItemSchema).default([]),
      removed: z.array(z.object({ type: artifactTypeWireSchema, slug: z.string() })).default([]),
      modified: z.array(inventoryItemSchema).default([]),
    }),
  }),
  z.object({
    type: z.literal('catalog.update'),
    id: z.string(),
    payload: z.object({
      artifactId: z.string(),
      slug: z.string(),
      type: artifactTypeWireSchema,
      version: z.string(),
    }),
  }),
]);

export type WssMessage = z.infer<typeof wssMessageSchema>;
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

export function parseMessage(raw: unknown): WssMessage {
  return wssMessageSchema.parse(raw);
}
