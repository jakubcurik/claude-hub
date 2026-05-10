// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { startMinio, type MinioFixture } from '../../test/helpers/minio.js';
import {
  __resetMinioClientForTests,
  bootstrapBucket,
  getArtifactBlobStream,
  manifestKey,
  presignDownload,
  putArtifactBlob,
  storageKey,
} from './minio.js';

describe('minio storage', () => {
  let fixture: MinioFixture;

  beforeAll(async () => {
    fixture = await startMinio();
    process.env.MINIO_ENDPOINT = fixture.endpoint;
    process.env.MINIO_ACCESS_KEY = fixture.accessKey;
    process.env.MINIO_SECRET_KEY = fixture.secretKey;
    process.env.MINIO_BUCKET = 'claude-hub-artifacts';
    __resetMinioClientForTests();
    await bootstrapBucket();
  }, 180_000);

  afterAll(async () => {
    await fixture.stop();
    __resetMinioClientForTests();
  });

  it('storageKey + manifestKey produce expected paths', () => {
    expect(storageKey('art-1', '0.1.0')).toBe('artifacts/art-1/0.1.0.tar.gz');
    expect(manifestKey('art-1', '0.1.0')).toBe('artifacts/art-1/0.1.0.manifest.json');
  });

  it('round-trips bytes through put + get', async () => {
    const bytes = Buffer.from('hello-hub');
    await putArtifactBlob('artifacts/test/0.1.0.tar.gz', bytes);
    const stream = await getArtifactBlobStream('artifacts/test/0.1.0.tar.gz');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello-hub');
  });

  it('presignDownload returns URL that downloads matching bytes', async () => {
    const bytes = Buffer.from('signed-bytes');
    await putArtifactBlob('artifacts/test/0.2.0.tar.gz', bytes);
    const url = await presignDownload('artifacts/test/0.2.0.tar.gz', 60);
    const resp = await fetch(url);
    const ab = await resp.arrayBuffer();
    expect(createHash('sha256').update(Buffer.from(ab)).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });
});
