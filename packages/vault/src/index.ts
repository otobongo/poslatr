import sodium from 'libsodium-wrappers';
import type { Database, Executor } from '@poslatr/db';
import {
  findEncryptedCredential,
  insertEncryptedCredential,
  listCredentialsNotOnVersion,
  replaceEncryptedCredential,
  withTransaction,
} from '@poslatr/db';
import { open, seal } from './internal/crypto.js';
import { VaultKeyVersionError, VaultNotFoundError, VaultRotationError } from './internal/errors.js';
import { RedactedCredentials, type DecryptedCredentials } from './internal/redacted.js';

// The vault's runtime exports are exactly these three functions (PRD ISS-004).
// Error classes stay internal (match on err.name); DecryptedCredentials is a
// type-only export. A unit test pins this surface.

export type { DecryptedCredentials };

// Hard ceiling on serialized credential size. Provider tokens are hundreds of
// bytes; anything near this bound is a bug or abuse (SECURITY.md 2.3).
const MAX_PLAINTEXT_BYTES = 64 * 1024;

export interface VaultKeyConfig {
  /** Base64 master key, normally env VAULT_MASTER_KEY. Validated on every call. */
  masterKey: string;
  /** Version tag written on new encryptions, normally env VAULT_KEY_VERSION. */
  keyVersion: number;
  /** Set only while a rotation is in progress (env VAULT_MASTER_KEY_PREVIOUS). */
  previousMasterKey?: string;
}

export async function encryptCredentials(
  db: Executor,
  workspaceId: string,
  plaintext: Record<string, unknown>,
  config: VaultKeyConfig,
): Promise<{ credentialId: string }> {
  assertKeyVersion(config.keyVersion);

  const serialized = Buffer.from(JSON.stringify(plaintext), 'utf8');
  if (serialized.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`Credential payload exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  try {
    const box = await seal(serialized, config.masterKey);
    const { id } = await insertEncryptedCredential(db, workspaceId, {
      ciphertext: box.ciphertext,
      nonce: box.nonce,
      keyVersion: config.keyVersion,
    });
    return { credentialId: id };
  } finally {
    sodium.memzero(serialized);
  }
}

export async function decryptCredentials(
  db: Executor,
  workspaceId: string,
  credentialId: string,
  config: VaultKeyConfig,
): Promise<DecryptedCredentials> {
  assertKeyVersion(config.keyVersion);

  const row = await findEncryptedCredential(db, workspaceId, credentialId);
  if (!row) {
    throw new VaultNotFoundError(credentialId);
  }

  let key: string;
  if (row.keyVersion === config.keyVersion) {
    key = config.masterKey;
  } else if (config.previousMasterKey !== undefined) {
    // Row predates the current key (rotation in progress). Wrong-key attempts
    // fail authentication identically to tampering, so this cannot decrypt
    // with a key it should not.
    key = config.previousMasterKey;
  } else {
    throw new VaultKeyVersionError(row.keyVersion, config.keyVersion);
  }

  const opened = await open({ ciphertext: row.ciphertext, nonce: row.nonce }, key);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(opened).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Stored plaintext is always an object; anything else means corruption
      // that somehow authenticated, which should be impossible.
      throw new VaultNotFoundError(credentialId);
    }
    return new RedactedCredentials(parsed as Record<string, unknown>);
  } finally {
    sodium.memzero(opened);
  }
}

export interface RotationResult {
  rotated: number;
}

/**
 * Re-encrypts every stored credential from the previous master key to the new
 * one, in transactional batches (PRD ISS-004).
 *
 * Resumable by construction: the work list is "rows not on newKeyVersion", and
 * each row's update is conditional on its observed key version. Interrupt this
 * anywhere and a re-run picks up exactly the unfinished rows; rows a previous
 * run completed no longer match the work list. A concurrent duplicate rotation
 * is also safe: the conditional update means each row is rotated exactly once.
 */
export async function rotateMasterKey(
  db: Database,
  options: {
    previousMasterKey: string;
    newMasterKey: string;
    newKeyVersion: number;
    batchSize?: number;
  },
): Promise<RotationResult> {
  assertKeyVersion(options.newKeyVersion);
  const batchSize = options.batchSize ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError(`batchSize must be an integer in [1, 1000], got ${batchSize}`);
  }

  let rotated = 0;
  for (;;) {
    const batch = await listCredentialsNotOnVersion(db, options.newKeyVersion, batchSize);
    if (batch.length === 0) {
      return { rotated };
    }

    rotated += await withTransaction(db, async (tx) => {
      let done = 0;
      for (const row of batch) {
        let opened: Uint8Array;
        try {
          opened = await open(
            { ciphertext: row.ciphertext, nonce: row.nonce },
            options.previousMasterKey,
          );
        } catch {
          // Halt loudly, naming the row: a credential that does not decrypt
          // with the previous key means either data corruption or a key mix-up,
          // and silently skipping it would leave an unreadable credential
          // behind a healthy-looking rotation.
          throw new VaultRotationError(row.id);
        }
        try {
          const box = await seal(opened, options.newMasterKey);
          done += await replaceEncryptedCredential(tx, row.workspaceId, row.id, row.keyVersion, {
            ciphertext: box.ciphertext,
            nonce: box.nonce,
            keyVersion: options.newKeyVersion,
          });
        } finally {
          sodium.memzero(opened);
        }
      }
      return done;
    });
  }
}

function assertKeyVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError(`keyVersion must be a positive integer, got ${version}`);
  }
}
