// SPDX-License-Identifier: Apache-2.0
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';
import { Client } from 'minio';

export interface MinioFixture {
  container: StartedMinioContainer;
  client: Client;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop: () => Promise<void>;
}

// MinioContainer v10+ generates credentials at runtime; we read them via
// getUsername()/getPassword() rather than hard-coding 'minioadmin'.
// (The plan's helper used getEndpoint() + hard-coded creds; that API
// only existed in older versions.)
export async function startMinio(): Promise<MinioFixture> {
  const container = await new MinioContainer('minio/minio:RELEASE.2024-10-13T13-34-11Z').start();
  const endpoint = container.getConnectionUrl();
  const url = new URL(endpoint);
  const accessKey = container.getUsername();
  const secretKey = container.getPassword();
  const client = new Client({
    endPoint: url.hostname,
    port: Number.parseInt(url.port, 10),
    useSSL: url.protocol === 'https:',
    accessKey,
    secretKey,
  });
  try {
    await client.makeBucket('claude-hub-artifacts');
  } catch {
    // ignore "bucket already exists"
  }
  return {
    container,
    client,
    endpoint,
    accessKey,
    secretKey,
    stop: () => container.stop(),
  };
}
