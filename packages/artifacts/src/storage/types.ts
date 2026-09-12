export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType?: string;
}

/**
 * Where artifact bytes actually live - local FS in dev, MinIO (S3-compatible)
 * in docker-compose/prod. Everything else in this package (and every
 * caller) only ever talks to this interface, never to `fs` or the S3
 * client directly.
 */
export interface StorageBackend {
  put(input: PutObjectInput): Promise<void>;
  get(key: string): Promise<Buffer>;
  /**
   * A URL the web app can point an `<img>`/`<a>`/`fetch` at to read this
   * object directly. For local storage this is a path on apps/server's own
   * `/artifacts/:key` proxy route (see apps/server/src/index.ts); for S3
   * it's a presigned, time-limited URL straight to MinIO.
   */
  getUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}
