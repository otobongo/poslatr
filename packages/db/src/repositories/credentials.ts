import { and, eq, ne, asc } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../client.js';
import { NotFoundError } from '../errors.js';
import { credentials } from '../schema/credentials.js';

// This repository stores and returns OPAQUE encrypted material only. All
// encryption and decryption happens in packages/vault; nothing here can see a
// plaintext credential (SECURITY.md 2.1, 2.19).

const base64Text = z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be standard base64');

export const encryptedRecordInput = z.object({
  ciphertext: base64Text,
  nonce: base64Text,
  keyVersion: z.number().int().min(1),
});

export type EncryptedRecordInput = z.infer<typeof encryptedRecordInput>;

export interface EncryptedRecord extends EncryptedRecordInput {
  id: string;
  workspaceId: string;
}

export async function insertEncryptedCredential(
  db: Executor,
  workspaceId: string,
  input: EncryptedRecordInput,
): Promise<{ id: string }> {
  const parsed = encryptedRecordInput.parse(input);
  const [row] = await db
    .insert(credentials)
    .values({
      workspaceId,
      ciphertext: parsed.ciphertext,
      nonce: parsed.nonce,
      keyVersion: parsed.keyVersion,
    })
    .returning({ id: credentials.id });

  if (!row) {
    throw new Error('Insert returned no row');
  }
  return row;
}

export async function findEncryptedCredential(
  db: Executor,
  workspaceId: string,
  id: string,
): Promise<EncryptedRecord | null> {
  const [row] = await db
    .select({
      id: credentials.id,
      workspaceId: credentials.workspaceId,
      ciphertext: credentials.ciphertext,
      nonce: credentials.nonce,
      keyVersion: credentials.keyVersion,
    })
    .from(credentials)
    .where(and(eq(credentials.id, id), eq(credentials.workspaceId, workspaceId)))
    .limit(1);

  return row ?? null;
}

/**
 * Re-writes a credential's encrypted material during rotation. The WHERE pins
 * the previous keyVersion, so a row already rotated by a resumed run (or a
 * concurrent one) is skipped rather than double-processed: same conditional-
 * update discipline as the post-target claim.
 */
export async function replaceEncryptedCredential(
  db: Executor,
  workspaceId: string,
  id: string,
  expectedKeyVersion: number,
  input: EncryptedRecordInput,
): Promise<number> {
  const parsed = encryptedRecordInput.parse(input);
  const updated = await db
    .update(credentials)
    .set({
      ciphertext: parsed.ciphertext,
      nonce: parsed.nonce,
      keyVersion: parsed.keyVersion,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(credentials.id, id),
        eq(credentials.workspaceId, workspaceId),
        eq(credentials.keyVersion, expectedKeyVersion),
      ),
    )
    .returning({ id: credentials.id });

  return updated.length;
}

/**
 * The rotation work list: rows not yet on the target key version, oldest
 * first, in stable batches. Resumability falls out of the predicate — rows a
 * prior interrupted run already rotated no longer match.
 */
export async function listCredentialsNotOnVersion(
  db: Executor,
  targetKeyVersion: number,
  limit: number,
): Promise<EncryptedRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError(`limit must be an integer in [1, 1000], got ${limit}`);
  }
  return db
    .select({
      id: credentials.id,
      workspaceId: credentials.workspaceId,
      ciphertext: credentials.ciphertext,
      nonce: credentials.nonce,
      keyVersion: credentials.keyVersion,
    })
    .from(credentials)
    .where(ne(credentials.keyVersion, targetKeyVersion))
    .orderBy(asc(credentials.createdAt), asc(credentials.id))
    .limit(limit);
}

export async function deleteEncryptedCredential(
  db: Executor,
  workspaceId: string,
  id: string,
): Promise<void> {
  const deleted = await db
    .delete(credentials)
    .where(and(eq(credentials.id, id), eq(credentials.workspaceId, workspaceId)))
    .returning({ id: credentials.id });

  if (deleted.length === 0) {
    throw new NotFoundError('credential', id);
  }
}
