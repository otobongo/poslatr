import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { StorageClient, type StorageConfig } from './storage.js';
import { checksum, decidePresign, DEFAULT_ALLOWED_MIME_TYPES } from './media.js';

// These require a live MinIO. Set MINIO_TEST_ENDPOINT (host), MINIO_TEST_PORT,
// keys, and bucket to run them; otherwise they skip (same discipline as the db
// integration tests). CI provides a MinIO service so they run there.
const endpoint = process.env.MINIO_TEST_ENDPOINT;
const describeMinio = endpoint ? describe : describe.skip;

function config(): StorageConfig {
  return {
    endpoint: endpoint as string,
    port: Number(process.env.MINIO_TEST_PORT ?? '9000'),
    useSsl: process.env.MINIO_TEST_SSL === 'true',
    accessKey: process.env.MINIO_TEST_ACCESS_KEY ?? 'poslatr-dev',
    secretKey: process.env.MINIO_TEST_SECRET_KEY ?? 'poslatr-dev-secret-change-me',
    bucket: process.env.MINIO_TEST_BUCKET ?? 'poslatr-media',
  };
}

async function png(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#0af' } })
      .png()
      .toBuffer(),
  );
}

describeMinio('storage against a live MinIO', () => {
  let storage: StorageClient;

  beforeAll(() => {
    storage = new StorageClient(config());
  });

  afterAll(() => {
    // S3Client sockets are cleaned up by the process; nothing to close here.
  });

  it('the bucket passes the private-bucket boot check', async () => {
    await expect(storage.assertPrivateBucketAtBoot()).resolves.toBeUndefined();
  });

  it('round-trips an object put and get', async () => {
    const bytes = await png();
    const decision = decidePresign(
      { workspaceId: 'itest', declaredMime: 'image/png', declaredBytes: bytes.length },
      { allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES, maxBytes: 1024 * 1024 },
    );
    await storage.putObject(decision.storageKey, bytes, 'image/png');
    const fetched = await storage.getObject(decision.storageKey);
    expect(checksum(fetched)).toBe(checksum(bytes));
  });

  it('a signed GET url works before its TTL and 403s after (PRD ISS-006 test case 3)', async () => {
    const bytes = await png();
    const key = `itest/${Date.now()}-ttl.png`;
    await storage.putObject(key, bytes, 'image/png');

    // 2s TTL: fetch immediately (works), then after expiry (403).
    const url = await storage.presignGet(key, 2);
    const early = await fetch(url);
    expect(early.status).toBe(200);

    await new Promise((r) => setTimeout(r, 2500));
    const late = await fetch(url);
    expect(late.status).toBe(403);
  });

  it('an unsigned object url is denied (private bucket)', async () => {
    const bytes = await png();
    const key = `itest/${Date.now()}-unsigned.png`;
    await storage.putObject(key, bytes, 'image/png');

    const cfg = config();
    const scheme = cfg.useSsl ? 'https' : 'http';
    const unsigned = `${scheme}://${cfg.endpoint}:${cfg.port}/${cfg.bucket}/${key}`;
    const res = await fetch(unsigned);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
