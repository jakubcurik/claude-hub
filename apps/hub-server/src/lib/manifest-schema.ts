// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { artifactTypeSchema, slugSchema } from './validators.js';

export const artifactManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: slugSchema,
  type: artifactTypeSchema,
  description: z.string().min(1),
  typeMeta: z.record(z.unknown()).default({}),
  signatures: z
    .array(
      z.object({
        algo: z.string(),
        keyId: z.string(),
        signature: z.string(),
      }),
    )
    .default([]),
});

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
