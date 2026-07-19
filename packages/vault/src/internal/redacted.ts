import { inspect } from 'node:util';

export interface DecryptedCredentials {
  /** The only way to read the plaintext. Deliberately verbose at call sites. */
  reveal(): Record<string, unknown>;
  /** Always throws: credentials must never be serialized (PRD ISS-004). */
  toJSON(): never;
  /** Returns a redacted placeholder, never plaintext. */
  toString(): string;
}

/**
 * Wraps decrypted credential plaintext so it cannot leak by accident:
 * JSON.stringify throws (PRD ISS-004 test case 4), console.log and string
 * coercion print a placeholder, and enumeration finds nothing because the data
 * lives in a private field.
 */
export class RedactedCredentials implements DecryptedCredentials {
  readonly #data: Record<string, unknown>;

  constructor(data: Record<string, unknown>) {
    this.#data = data;
  }

  reveal(): Record<string, unknown> {
    // Return a deep clone, not the live internal reference (ISS-004-F2): a
    // caller mutating the result must not corrupt vault-internal state.
    return structuredClone(this.#data);
  }

  toJSON(): never {
    throw new Error('Refusing to serialize credentials; call reveal() if you really need them');
  }

  toString(): string {
    return '[RedactedCredentials]';
  }

  [inspect.custom](): string {
    return '[RedactedCredentials]';
  }
}
