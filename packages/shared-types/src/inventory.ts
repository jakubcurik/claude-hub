// SPDX-License-Identifier: Apache-2.0
import type { UUID } from './users.js';
import type { ArtifactType } from './artifacts.js';

export interface PublishedAsRef {
  artifactId: UUID;
  version: string;
}

export interface InventoryItem {
  type: ArtifactType;
  slug: string;
  version: string | null;
  path: string;
  enabled: boolean | null;
  publishedAs?: PublishedAsRef;
}
