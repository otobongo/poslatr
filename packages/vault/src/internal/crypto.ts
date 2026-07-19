import sodium from 'libsodium-wrappers';
import { parseVaultMasterKey } from '@poslatr/core';
import { VaultDecryptionError } from './errors.js';

let ready: Promise<void> | undefined;

function init(): Promise<void> {
  ready ??= sodium.ready;
  return ready;
}

export interface SealedBox {
  ciphertext: string; // base64
  nonce: string; // base64
}

/**
 * XSalsa20-Poly1305 secretbox with a fresh random 24-byte nonce per call.
 * Nonce reuse is impossible by construction: the nonce is generated here from
 * sodium's CSPRNG on every encryption and never accepted from a caller.
 */
export async function seal(plaintext: Uint8Array, masterKeyBase64: string): Promise<SealedBox> {
  await init();
  const key = parseVaultMasterKey(masterKeyBase64);
  try {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const box = sodium.crypto_secretbox_easy(plaintext, nonce, key);
    return {
      ciphertext: Buffer.from(box).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
    };
  } finally {
    sodium.memzero(key);
  }
}

export async function open(box: SealedBox, masterKeyBase64: string): Promise<Uint8Array> {
  await init();
  const key = parseVaultMasterKey(masterKeyBase64);
  try {
    const opened = sodium.crypto_secretbox_open_easy(
      Buffer.from(box.ciphertext, 'base64'),
      Buffer.from(box.nonce, 'base64'),
      key,
    );
    return opened;
  } catch {
    // Poly1305 authentication failure (tampered ciphertext, wrong key, or
    // corrupted nonce) all surface identically, with no partial output.
    throw new VaultDecryptionError();
  } finally {
    sodium.memzero(key);
  }
}
