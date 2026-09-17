import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3StorageConfig } from '../env.js';
import type { PutObjectInput, StorageBackend } from './types.js';

const PRESIGNED_URL_TTL_SECONDS = 15 * 60;

/**
 * MinIO (S3-compatible) storage. `forcePathStyle: true` is required for
 * MinIO - it doesn't support the AWS-style virtual-hosted bucket addressing
 * (`bucket.endpoint.com`) the SDK defaults to.
 */
export class S3ArtifactStorage implements StorageBackend {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body;
    if (!body) {
      throw new Error(`S3ArtifactStorage.get: no body returned for key "${key}"`);
    }
    // The v3 SDK's `Body` is a `ByteStream` union (Node Readable in
    // practice, on Node runtimes) - `transformToByteArray()` is its own
    // documented, runtime-agnostic way to fully buffer it.
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async getUrl(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
    });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
