// SPDX-License-Identifier: Apache-2.0
import { Client } from 'minio';

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
      await client.listBuckets();
    },
  };
}
