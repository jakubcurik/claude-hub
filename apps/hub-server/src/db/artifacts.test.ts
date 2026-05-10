// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  artifacts,
  artifactVersions,
  installEvents,
  artifactTypeEnum,
  installStatusEnum,
} from './schema.js';

describe('artifacts schema', () => {
  it('exposes artifact_type enum with 4 values', () => {
    expect(artifactTypeEnum.enumValues).toEqual(['skill', 'plugin', 'command', 'agent']);
  });
  it('exposes install_status enum with 3 values', () => {
    expect(installStatusEnum.enumValues).toEqual(['success', 'failed', 'rolled_back']);
  });
  it('artifacts.slug is notNull and unique', () => {
    expect(artifacts.slug.notNull).toBe(true);
    expect(artifacts.slug.isUnique).toBe(true);
  });
  it('artifact_versions has manifest jsonb column', () => {
    expect(artifactVersions.manifest.dataType).toBe('json');
  });
  it('install_events references daemons and artifact_versions', () => {
    expect(installEvents.daemonId.notNull).toBe(true);
    expect(installEvents.artifactVersionId.notNull).toBe(true);
  });
});
