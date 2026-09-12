import { getStorage } from '@katnor/artifacts';

/**
 * Reads an artifact's raw text content from whichever storage backend is
 * configured (local disk or MinIO/S3 - `getStorage()` abstracts over both,
 * same as apps/server's `/artifacts/raw/:key` route).
 */
export async function readArtifactText(storageKey: string): Promise<string> {
  const buffer = await getStorage().get(storageKey);
  return buffer.toString('utf8');
}
