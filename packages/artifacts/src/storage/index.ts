import { getLocalStorageDir, getS3Config, getStorageMode } from '../env.js';
import { LocalFsStorage } from './local.js';
import { S3ArtifactStorage } from './s3.js';
import type { StorageBackend } from './types.js';

let cached: StorageBackend | undefined;

/** The one storage backend for the process, chosen by ARTIFACT_STORAGE (default "local"). */
export function getStorage(): StorageBackend {
  if (cached) return cached;
  cached = getStorageMode() === 's3' ? new S3ArtifactStorage(getS3Config()) : new LocalFsStorage(getLocalStorageDir());
  return cached;
}

export * from './types.js';
