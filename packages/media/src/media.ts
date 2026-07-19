import { createHash, randomUUID } from 'node:crypto';

// Server-side media rules. Presign validation happens BEFORE a URL is issued
// (size + mime allowlist), storage keys are always server-generated, and
// content is validated by magic bytes, not by the client-declared type.

export const DEFAULT_ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export interface PresignPolicy {
  allowedMimeTypes: readonly string[];
  maxBytes: number;
}

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

export interface PresignRequest {
  workspaceId: string;
  declaredMime: string;
  declaredBytes: number;
}

export interface PresignDecision {
  storageKey: string;
  mime: string;
}

/**
 * Validates a presign request and returns a server-generated storage key.
 * Rejects a disallowed mime or an oversize declaration BEFORE any URL is
 * issued (PRD ISS-006 test case 1). The key is UUID-based and namespaced by
 * workspace; the client filename never touches it (SECURITY.md 2.11).
 */
export function decidePresign(request: PresignRequest, policy: PresignPolicy): PresignDecision {
  if (!policy.allowedMimeTypes.includes(request.declaredMime)) {
    throw new MediaValidationError(`mime type ${request.declaredMime} is not allowed`);
  }
  if (!Number.isInteger(request.declaredBytes) || request.declaredBytes <= 0) {
    throw new MediaValidationError('declared size must be a positive integer');
  }
  if (request.declaredBytes > policy.maxBytes) {
    throw new MediaValidationError(
      `declared size ${request.declaredBytes} exceeds the ${policy.maxBytes} byte limit`,
    );
  }
  return {
    storageKey: `${request.workspaceId}/${randomUUID()}`,
    mime: request.declaredMime,
  };
}

export function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Magic-byte signatures (SECURITY.md 2.11: validate by content, not extension).
const SIGNATURES: Array<{ mime: string; test: (b: Uint8Array) => boolean }> = [
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/gif',
    test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

/** Detects the content type from magic bytes, or null if unrecognized. */
export function detectMime(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (sig.test(bytes)) return sig.mime;
  }
  return null;
}

/**
 * Asserts the actual bytes match the declared/allowed mime. Called after upload
 * completes, before an asset row is trusted: a client that declared image/png
 * but uploaded something else is rejected here.
 */
export function assertContentMatches(bytes: Uint8Array, declaredMime: string): void {
  const actual = detectMime(bytes);
  if (actual === null) {
    throw new MediaValidationError('uploaded content is not a recognized image type');
  }
  if (actual !== declaredMime) {
    throw new MediaValidationError(
      `uploaded content is ${actual} but was declared ${declaredMime}`,
    );
  }
}
