// Error classes are deliberately NOT exported from the package: the vault's
// public surface is exactly encryptCredentials, decryptCredentials, and
// rotateMasterKey (PRD ISS-004). Consumers match on the stable `name` field.

export class VaultDecryptionError extends Error {
  constructor() {
    // No detail on purpose: the failure reason (tampered vs wrong key) must not
    // be distinguishable to a caller, and no ciphertext or key material may
    // appear in the message (SECURITY.md 2.16).
    super('Credential decryption failed');
    this.name = 'VaultDecryptionError';
  }
}

export class VaultKeyVersionError extends Error {
  constructor(rowVersion: number, currentVersion: number) {
    super(
      `Credential is encrypted with key version ${rowVersion}, but only version ${currentVersion} is loaded; ` +
        'set VAULT_MASTER_KEY_PREVIOUS and run rotation',
    );
    this.name = 'VaultKeyVersionError';
  }
}

export class VaultNotFoundError extends Error {
  constructor(id: string) {
    super(`Credential ${id} not found in this workspace`);
    this.name = 'VaultNotFoundError';
  }
}

export class VaultRotationError extends Error {
  readonly credentialId: string;

  constructor(credentialId: string) {
    // The id is not secret and is exactly what an operator needs to find the
    // undecryptable row; key material and ciphertext stay out of the message.
    super(
      `Rotation halted: credential ${credentialId} does not decrypt with the previous master key. ` +
        'Nothing was lost (batches are transactional); fix or remove that row and re-run.',
    );
    this.name = 'VaultRotationError';
    this.credentialId = credentialId;
  }
}
