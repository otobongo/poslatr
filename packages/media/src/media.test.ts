import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  assertContentMatches,
  checksum,
  decidePresign,
  DEFAULT_ALLOWED_MIME_TYPES,
  detectMime,
  MediaValidationError,
  type PresignPolicy,
} from './media.js';
import { ImageRenditioner, probeImage, VideoRenditionerNotImplemented } from './renditions.js';

const policy: PresignPolicy = {
  allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES,
  maxBytes: 1024 * 1024,
};

async function pngBytes(width = 32, height = 32): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

describe('decidePresign (PRD ISS-006 test case 1)', () => {
  it('rejects a disallowed mime', () => {
    expect(() =>
      decidePresign(
        { workspaceId: 'w', declaredMime: 'application/x-msdownload', declaredBytes: 10 },
        policy,
      ),
    ).toThrow(MediaValidationError);
  });

  it('rejects an oversize declaration', () => {
    expect(() =>
      decidePresign(
        { workspaceId: 'w', declaredMime: 'image/png', declaredBytes: policy.maxBytes + 1 },
        policy,
      ),
    ).toThrow(MediaValidationError);
  });

  it('rejects a non-positive size', () => {
    expect(() =>
      decidePresign({ workspaceId: 'w', declaredMime: 'image/png', declaredBytes: 0 }, policy),
    ).toThrow(MediaValidationError);
  });

  it('generates a server-side, workspace-namespaced key that ignores any filename', () => {
    const decision = decidePresign(
      { workspaceId: 'ws-123', declaredMime: 'image/png', declaredBytes: 100 },
      policy,
    );
    expect(decision.storageKey.startsWith('ws-123/')).toBe(true);
    // UUID after the slash, nothing client-derived.
    expect(decision.storageKey).toMatch(
      /^ws-123\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('produces a distinct key each call', () => {
    const req = { workspaceId: 'w', declaredMime: 'image/png', declaredBytes: 100 } as const;
    expect(decidePresign(req, policy).storageKey).not.toBe(decidePresign(req, policy).storageKey);
  });
});

describe('checksum', () => {
  it('is a stable lowercase hex SHA-256', () => {
    const c = checksum(new Uint8Array([1, 2, 3]));
    expect(c).toMatch(/^[a-f0-9]{64}$/);
    expect(checksum(new Uint8Array([1, 2, 3]))).toBe(c);
  });

  it('differs for different content', () => {
    expect(checksum(new Uint8Array([1]))).not.toBe(checksum(new Uint8Array([2])));
  });
});

describe('content-type detection by magic bytes (SECURITY.md 2.11)', () => {
  it('detects a real PNG', async () => {
    expect(detectMime(await pngBytes())).toBe('image/png');
  });

  it('detects a real JPEG and WEBP', async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    const webp = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).webp().toBuffer());
    expect(detectMime(jpeg)).toBe('image/jpeg');
    expect(detectMime(webp)).toBe('image/webp');
  });

  it('returns null for non-image content', () => {
    expect(detectMime(new TextEncoder().encode('#!/bin/sh\nrm -rf /'))).toBeNull();
  });

  it('rejects a mismatch between declared and actual type', async () => {
    const png = await pngBytes();
    expect(() => assertContentMatches(png, 'image/jpeg')).toThrow(MediaValidationError);
  });

  it('accepts a matching declaration', async () => {
    const png = await pngBytes();
    expect(() => assertContentMatches(png, 'image/png')).not.toThrow();
  });

  it('rejects content masquerading as an allowed type', () => {
    const fake = new TextEncoder().encode('this is not a png');
    expect(() => assertContentMatches(fake, 'image/png')).toThrow(MediaValidationError);
  });
});

describe('image renditions', () => {
  it('resizes within bounds and never enlarges', async () => {
    const source = await pngBytes(1000, 500);
    const out = await new ImageRenditioner().render(source, {
      name: 'standard',
      maxWidth: 400,
      maxHeight: 400,
      format: 'image/webp',
    });
    expect(out.mime).toBe('image/webp');
    expect(out.width).toBeLessThanOrEqual(400);
    expect(out.height).toBeLessThanOrEqual(400);
    // Aspect ratio preserved: 1000x500 -> 400x200.
    expect(out.width).toBe(400);
    expect(out.height).toBe(200);
    expect(detectMime(out.bytes)).toBe('image/webp');
  });

  it('does not enlarge a small source', async () => {
    const source = await pngBytes(50, 50);
    const out = await new ImageRenditioner().render(source, {
      name: 'standard',
      maxWidth: 400,
      maxHeight: 400,
      format: 'image/png',
    });
    expect(out.width).toBe(50);
    expect(out.height).toBe(50);
  });

  it('probes image dimensions', async () => {
    expect(await probeImage(await pngBytes(64, 48))).toMatchObject({ width: 64, height: 48 });
  });

  it('video renditioner rejects, interface-only in v0.1', async () => {
    await expect(
      new VideoRenditionerNotImplemented().render(new Uint8Array(), {
        name: 'x',
        maxWidth: 1,
        maxHeight: 1,
        format: 'image/png',
      }),
    ).rejects.toThrow(/not supported/);
  });
});
