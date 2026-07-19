// Master-key material validation, shared by the env loader (boot-time refusal)
// and packages/vault (defense in depth on every call). Lives in core because
// the vault package's public surface is fixed to exactly three functions
// (PRD ISS-004) and cannot export helpers.

export const VAULT_MASTER_KEY_BYTES = 32;

// A genuinely random 32-byte key has ~28 distinct byte values on average;
// fewer than 16 is astronomically unlikely for real randomness and catches
// all-zero keys, single-repeated-byte keys, and short-alphabet passwords
// hand-typed into the env var.
const MIN_DISTINCT_BYTES = 16;

export class InvalidMasterKeyError extends Error {
  constructor(reason: string) {
    // Deliberately never includes any part of the key material.
    super(`Invalid vault master key: ${reason}`);
    this.name = 'InvalidMasterKeyError';
  }
}

const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parses a base64-encoded master key, enforcing length and an entropy floor.
 * Throws InvalidMasterKeyError (never echoing key material) on failure.
 */
export function parseVaultMasterKey(value: string): Uint8Array {
  // Buffer.from silently tolerates malformed base64, so gate on canonical form
  // first rather than trusting the decoder.
  if (value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) {
    throw new InvalidMasterKeyError('not valid base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== VAULT_MASTER_KEY_BYTES) {
    throw new InvalidMasterKeyError(
      `must decode to exactly ${VAULT_MASTER_KEY_BYTES} bytes, got ${decoded.length}`,
    );
  }
  const distinct = new Set(decoded).size;
  if (distinct < MIN_DISTINCT_BYTES) {
    throw new InvalidMasterKeyError(
      `entropy too low (${distinct} distinct byte values, need at least ${MIN_DISTINCT_BYTES}); generate with: openssl rand -base64 32`,
    );
  }
  return new Uint8Array(decoded);
}

export function isValidVaultMasterKey(value: string): boolean {
  try {
    parseVaultMasterKey(value);
    return true;
  } catch {
    return false;
  }
}
