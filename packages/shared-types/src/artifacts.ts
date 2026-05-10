// SPDX-License-Identifier: Apache-2.0
import type { UUID } from './users.js';

export type ArtifactType = 'skill' | 'plugin' | 'command' | 'agent';

export interface ArtifactManifest {
  schemaVersion: 1;
  name: string;
  type: ArtifactType;
  description: string;
  typeMeta: Record<string, unknown>;
}

export interface ArtifactDTO {
  id: UUID;
  slug: string;
  type: ArtifactType;
  description: string;
  ownerUserId: UUID;
  createdAt: string;
  archivedAt: string | null;
  latestVersion: string | null;
}

export interface ArtifactVersionDTO {
  id: UUID;
  artifactId: UUID;
  version: string;
  sha256: string;
  manifest: ArtifactManifest;
  publishedByUserId: UUID;
  publishedAt: string;
  deprecated: boolean;
}
