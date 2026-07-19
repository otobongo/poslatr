import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, schema, type DatabaseHandle } from '@poslatr/db';
import { createWorkspace } from '@poslatr/db';
import { eq } from 'drizzle-orm';
import * as vault from './index.js';
import { decryptCredentials, encryptCredentials, rotateMasterKey } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');

describe('vault public surface (PRD ISS-004)', () => {
  it('exports exactly encryptCredentials, decryptCredentials, rotateMasterKey at runtime', () => {
    const runtimeExports = Object.keys(vault).sort();
    expect(runtimeExports).toEqual([
      'decryptCredentials',
      'encryptCredentials',
      'rotateMasterKey',
    ]);
  });
});

describeIntegration('vault against a live database', () => {
  let handle: DatabaseHandle;
  let workspaceId: string;

  beforeAll(async () => {
    handle = connect(databaseUrl as string, { max: 5 });
    const ws = await createWorkspace(handle.db, { name: `vault-test-${Date.now()}` });
    workspaceId = ws.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  const config = { masterKey: keyA, keyVersion: 1 };

  it('round-trips credentials (test case 1)', async () => {
    const secret = { accessToken: 'tok-abc', refreshToken: 'ref-xyz', instance: 'https://m.example' };
    const { credentialId } = await encryptCredentials(handle.db, workspaceId, secret, config);

    const decrypted = await decryptCredentials(handle.db, workspaceId, credentialId, config);
    expect(decrypted.reveal()).toEqual(secret);
  });

  it('stores opaque ciphertext, not plaintext, in the database', async () => {
    const secret = { accessToken: 'super-secret-token-value' };
    const { credentialId } = await encryptCredentials(handle.db, workspaceId, secret, config);

    const [row] = await handle.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.id, credentialId));
    expect(row).toBeDefined();
    expect(row?.ciphertext).not.toContain('super-secret-token-value');
    expect(Buffer.from(row?.ciphertext ?? '', 'base64').toString('utf8')).not.toContain(
      'super-secret-token-value',
    );
  });

  it('fails authentication on tampered ciphertext with a typed error and no partial output (test case 2)', async () => {
    const { credentialId } = await encryptCredentials(handle.db, workspaceId, { t: 'x' }, config);

    // Flip one byte of the stored ciphertext.
    const [row] = await handle.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.id, credentialId));
    const tampered = Buffer.from(row?.ciphertext ?? '', 'base64');
    tampered[0] = tampered[0] ^ 0xff;
    await handle.db
      .update(schema.credentials)
      .set({ ciphertext: tampered.toString('base64') })
      .where(eq(schema.credentials.id, credentialId));

    try {
      await decryptCredentials(handle.db, workspaceId, credentialId, config);
      throw new Error('expected decryption to throw');
    } catch (err) {
      expect((err as Error).name).toBe('VaultDecryptionError');
      // No plaintext, ciphertext, or key material in the message.
      expect((err as Error).message).toBe('Credential decryption failed');
    }
  });

  it('fails identically with the wrong key', async () => {
    const { credentialId } = await encryptCredentials(handle.db, workspaceId, { t: 'y' }, config);
    await expect(
      decryptCredentials(handle.db, workspaceId, credentialId, { masterKey: keyB, keyVersion: 1 }),
    ).rejects.toMatchObject({ name: 'VaultDecryptionError' });
  });

  it('does not resolve credentials across workspaces', async () => {
    const other = await createWorkspace(handle.db, { name: `vault-other-${Date.now()}` });
    const { credentialId } = await encryptCredentials(handle.db, workspaceId, { t: 'z' }, config);

    await expect(
      decryptCredentials(handle.db, other.id, credentialId, config),
    ).rejects.toMatchObject({ name: 'VaultNotFoundError' });
  });

  it('reveal() returns a clone, not the live internal reference (ISS-004-F2)', async () => {
    const { credentialId } = await encryptCredentials(
      handle.db,
      workspaceId,
      { nested: { token: 'orig' } },
      config,
    );
    const decrypted = await decryptCredentials(handle.db, workspaceId, credentialId, config);

    const first = decrypted.reveal() as { nested: { token: string } };
    first.nested.token = 'mutated';
    const second = decrypted.reveal() as { nested: { token: string } };
    expect(second.nested.token).toBe('orig');
  });

  it('fails closed when the stored row is newer than the loaded key (ISS-004-F1)', async () => {
    // Encrypt under version 2, then ask to decrypt with a config on version 1
    // that offers a previous key. The row is NEWER than our config, so we must
    // refuse rather than blindly try the previous key.
    const { credentialId } = await encryptCredentials(handle.db, workspaceId, { t: 'newer' }, {
      masterKey: keyB,
      keyVersion: 2,
    });

    await expect(
      decryptCredentials(handle.db, workspaceId, credentialId, {
        masterKey: keyA,
        keyVersion: 1,
        previousMasterKey: keyA,
      }),
    ).rejects.toMatchObject({ name: 'VaultKeyVersionError' });
  });

  it('JSON.stringify on decrypted credentials throws (test case 4)', async () => {
    const { credentialId } = await encryptCredentials(handle.db, workspaceId, { s: 1 }, config);
    const decrypted = await decryptCredentials(handle.db, workspaceId, credentialId, config);

    expect(() => JSON.stringify(decrypted)).toThrow(/Refusing to serialize/);
    expect(String(decrypted)).toBe('[RedactedCredentials]');
    expect(inspect(decrypted)).toBe('[RedactedCredentials]');
  });

  it('never reuses a nonce across encryptions of identical plaintext', async () => {
    const same = { token: 'identical' };
    const ids = await Promise.all(
      Array.from({ length: 25 }, () => encryptCredentials(handle.db, workspaceId, same, config)),
    );

    const rows = await Promise.all(
      ids.map(async ({ credentialId }) => {
        const [row] = await handle.db
          .select({ nonce: schema.credentials.nonce, ciphertext: schema.credentials.ciphertext })
          .from(schema.credentials)
          .where(eq(schema.credentials.id, credentialId));
        return row;
      }),
    );

    const nonces = rows.map((r) => r?.nonce);
    expect(new Set(nonces).size).toBe(25);
    // Distinct nonces mean distinct ciphertexts for identical plaintext.
    expect(new Set(rows.map((r) => r?.ciphertext)).size).toBe(25);
  });

  describe('rotation (test case 3)', () => {
    beforeAll(async () => {
      // Rotation is deliberately global (every row not on the target version),
      // so stale rows from previous test runs encrypted under keys this
      // process never knew would halt it. Start from a clean table.
      await handle.db.delete(schema.credentials);
    });

    it('halts loudly, naming the row, when a credential does not decrypt', async () => {
      const { credentialId } = await encryptCredentials(
        handle.db,
        workspaceId,
        { stale: true },
        { masterKey: randomBytes(32).toString('base64'), keyVersion: 1 },
      );

      try {
        await rotateMasterKey(handle.db, {
          previousMasterKey: keyA,
          newMasterKey: keyB,
          newKeyVersion: 2,
        });
        throw new Error('expected rotation to throw');
      } catch (err) {
        expect((err as Error).name).toBe('VaultRotationError');
        expect((err as Error).message).toContain(credentialId);
      } finally {
        await handle.db.delete(schema.credentials);
      }
    });

    it('rotates 100 credentials, then the old key fails decryption', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 100; i += 1) {
        const { credentialId } = await encryptCredentials(
          handle.db,
          workspaceId,
          { n: i },
          { masterKey: keyA, keyVersion: 1 },
        );
        ids.push(credentialId);
      }

      const result = await rotateMasterKey(handle.db, {
        previousMasterKey: keyA,
        newMasterKey: keyB,
        newKeyVersion: 2,
        batchSize: 7,
      });
      // Exactly our 100: the suite starts from a clean table.
      expect(result.rotated).toBe(100);

      // New key decrypts; old key authenticates nothing.
      const first = await decryptCredentials(handle.db, workspaceId, ids[0], {
        masterKey: keyB,
        keyVersion: 2,
      });
      expect(first.reveal()).toEqual({ n: 0 });

      await expect(
        decryptCredentials(handle.db, workspaceId, ids[1], {
          masterKey: keyA,
          keyVersion: 2,
          previousMasterKey: keyA,
        }),
      ).rejects.toMatchObject({ name: 'VaultDecryptionError' });
    });

    it('an interrupted rotation resumes to completion without loss', async () => {
      // Fresh version pair so this test is independent of the previous one.
      const keyC = randomBytes(32).toString('base64');
      const ids: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        const { credentialId } = await encryptCredentials(
          handle.db,
          workspaceId,
          { r: i },
          { masterKey: keyB, keyVersion: 2 },
        );
        ids.push(credentialId);
      }

      // Genuine mid-rotation interrupt: a proxied db whose transaction() dies
      // after the first batch commits. Batch 1 lands durably; the process
      // "crashes" before batch 2 — the same observable state as a SIGKILL
      // between batches.
      let committedBatches = 0;
      const dying = new Proxy(handle.db, {
        get(target, prop, receiver): unknown {
          if (prop === 'transaction') {
            return async (fn: (tx: unknown) => Promise<unknown>) => {
              if (committedBatches >= 1) {
                throw new Error('simulated crash mid-rotation');
              }
              const result = await target.transaction(fn);
              committedBatches += 1;
              return result;
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });

      await expect(
        rotateMasterKey(dying, {
          previousMasterKey: keyB,
          newMasterKey: keyC,
          newKeyVersion: 3,
          batchSize: 5,
        }),
      ).rejects.toThrow(/simulated crash/);

      // Partial state is real: some rows rotated, some not.
      const remaining = await handle.db
        .select({ id: schema.credentials.id })
        .from(schema.credentials)
        .where(eq(schema.credentials.keyVersion, 2));
      expect(committedBatches).toBe(1);
      expect(remaining.length).toBeGreaterThan(0);

      // Resume with an intact process: completes the rest without loss.
      const resume = await rotateMasterKey(handle.db, {
        previousMasterKey: keyB,
        newMasterKey: keyC,
        newKeyVersion: 3,
        batchSize: 5,
      });
      expect(resume.rotated).toBe(remaining.length);

      // Every credential decrypts under the new key: nothing lost, including
      // rows from the batch that committed before the crash.
      for (const id of ids) {
        const d = await decryptCredentials(handle.db, workspaceId, id, {
          masterKey: keyC,
          keyVersion: 3,
        });
        expect(d.reveal()).toHaveProperty('r');
      }
    });
  });
});
