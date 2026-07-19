import {
  GetObjectCommand,
  GetBucketPolicyStatusCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// All storage access goes through the S3 SDK so Backblaze/R2/Drive are config
// swaps (PRD section 2). Nothing else in the codebase constructs an S3 client.

export interface StorageConfig {
  endpoint: string;
  port: number;
  useSsl: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

export class PublicBucketError extends Error {
  constructor(bucket: string) {
    super(`Bucket "${bucket}" is public; SECURITY.md 2.19 requires a private bucket`);
    this.name = 'PublicBucketError';
  }
}

export class StorageClient {
  readonly #s3: S3Client;
  readonly #bucket: string;

  constructor(config: StorageConfig) {
    const scheme = config.useSsl ? 'https' : 'http';
    this.#s3 = new S3Client({
      endpoint: `${scheme}://${config.endpoint}:${config.port}`,
      region: config.region ?? 'us-east-1',
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      // MinIO speaks path-style; virtual-host style needs DNS per bucket.
      forcePathStyle: true,
    });
    this.#bucket = config.bucket;
  }

  /**
   * Boot-time invariant (SECURITY.md 2.19, PRD ISS-006): the bucket must exist
   * and must not be public. Throws if either fails, so a misconfigured
   * deployment refuses to start rather than serving media openly.
   */
  async assertPrivateBucketAtBoot(): Promise<void> {
    await this.#s3.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    try {
      const status = await this.#s3.send(
        new GetBucketPolicyStatusCommand({ Bucket: this.#bucket }),
      );
      if (status.PolicyStatus?.IsPublic === true) {
        throw new PublicBucketError(this.#bucket);
      }
    } catch (err) {
      if (err instanceof PublicBucketError) throw err;
      // MinIO returns NoSuchBucketPolicy / not-implemented when no policy is
      // set, which is exactly the private default we want. Any other error is
      // real and should surface.
      const name = (err as { name?: string }).name ?? '';
      if (!/NoSuchBucketPolicy|NotImplemented|MethodNotAllowed/.test(name)) {
        throw err;
      }
    }
  }

  /**
   * Presigned PUT for a direct browser upload. The caller must have already
   * validated size and mime (see media.ts): this method assumes a
   * server-generated key and never trusts a client filename.
   */
  presignPut(storageKey: string, contentType: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.#s3,
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: storageKey,
        ContentType: contentType,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  /** Short-TTL signed GET (SECURITY.md 2.19, 15 min default). */
  presignGet(storageKey: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.#s3,
      new GetObjectCommand({ Bucket: this.#bucket, Key: storageKey }),
      { expiresIn: ttlSeconds },
    );
  }

  async putObject(storageKey: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: storageKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObject(storageKey: string): Promise<Uint8Array> {
    const result = await this.#s3.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: storageKey }),
    );
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error(`Object ${storageKey} had no body`);
    }
    return bytes;
  }
}
