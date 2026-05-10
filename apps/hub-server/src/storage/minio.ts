// SPDX-License-Identifier: Apache-2.0
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Client } from 'minio';
import type { Readable } from 'node:stream';
import { loadEnv } from '../env.js';

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface MinioContext {
  client: Client;
  bucket: string;
  ping: () => Promise<void>;
}

export function createMinioClient(cfg: MinioConfig): MinioContext {
  const url = new URL(cfg.endpoint);
  const client = new Client({
    endPoint: url.hostname,
    port: Number.parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10),
    useSSL: url.protocol === 'https:',
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
  });

  return {
    client,
    bucket: cfg.bucket,
    ping: async () => {
      await client.bucketExists(cfg.bucket);
    },
  };
}

let _client: S3Client | null = null;
let _bucket: string | null = null;

function getClient(): { s3: S3Client; bucket: string } {
  if (!_client) {
    const env = loadEnv();
    _client = new S3Client({
      endpoint: env.MINIO_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.MINIO_ACCESS_KEY,
        secretAccessKey: env.MINIO_SECRET_KEY,
      },
    });
    _bucket = env.MINIO_BUCKET;
  }
  return { s3: _client, bucket: _bucket! };
}

export function __resetMinioClientForTests(): void {
  _client = null;
  _bucket = null;
}

export async function bootstrapBucket(): Promise<void> {
  const { s3, bucket } = getClient();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export function storageKey(artifactId: string, version: string): string {
  return `artifacts/${artifactId}/${version}.tar.gz`;
}

export function manifestKey(artifactId: string, version: string): string {
  return `artifacts/${artifactId}/${version}.manifest.json`;
}

export async function putArtifactBlob(
  key: string,
  body: Buffer | Readable,
  contentType = 'application/gzip',
): Promise<void> {
  const { s3, bucket } = getClient();
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function getArtifactBlobStream(key: string): Promise<Readable> {
  const { s3, bucket } = getClient();
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return out.Body as Readable;
}

export async function presignDownload(key: string, ttlSec = 300): Promise<string> {
  const { s3, bucket } = getClient();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: ttlSec,
  });
}
