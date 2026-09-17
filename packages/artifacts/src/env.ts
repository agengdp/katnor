/**
 * Dependency-free env reading (no zod) - mirrors @katnor/db's src/env.ts
 * convention of keeping shared, cross-app packages free of a validation
 * library dependency; the apps that actually boot (server, worker) do
 * their own upfront env validation and this package is only ever used
 * from within those processes.
 */

export type ArtifactStorageMode = 'local' | 's3';

export function getStorageMode(): ArtifactStorageMode {
  const value = process.env.ARTIFACT_STORAGE?.trim().toLowerCase();
  return value === 's3' ? 's3' : 'local';
}

/** Local-mode only: the directory artifact content is written under. */
export function getLocalStorageDir(): string {
  return process.env.ARTIFACT_STORAGE_DIR?.trim() || '/tmp/katnor-artifacts';
}

export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/** S3-mode only: MinIO connection details. Throws with a clear message if anything required is missing. */
export function getS3Config(): S3StorageConfig {
  const endpoint = process.env.MINIO_ENDPOINT;
  const bucket = process.env.MINIO_BUCKET;
  const accessKeyId = process.env.MINIO_ROOT_USER;
  const secretAccessKey = process.env.MINIO_ROOT_PASSWORD;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'ARTIFACT_STORAGE=s3 requires MINIO_ENDPOINT, MINIO_BUCKET, MINIO_ROOT_USER, and ' +
        'MINIO_ROOT_PASSWORD to all be set - see .env.example.',
    );
  }
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.MINIO_REGION?.trim() || 'us-east-1',
  };
}
