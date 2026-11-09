import { DiskStorage } from './disk.js';
import { S3Storage } from './s3.js';
import type { Storage } from './types.js';

export type { Storage, StoredObject } from './types.js';

/**
 * Uses S3 when a bucket and its keys are set, otherwise a local folder. Leave S3_ENDPOINT_URL
 * out for Amazon S3, or set it for MinIO, Cloudflare R2 and other S3-compatible stores.
 */
export function createStorage(env: NodeJS.ProcessEnv = process.env): Storage {
  const { S3_ENDPOINT_URL, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION } = env;
  if (S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY) {
    return new S3Storage({
      endpoint: S3_ENDPOINT_URL || undefined,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
      region: S3_REGION ?? 'us-east-1',
    });
  }
  return new DiskStorage(env.DATA_DIR ?? '.data');
}
