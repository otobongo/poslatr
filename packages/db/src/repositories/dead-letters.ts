import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../client.js';
import { deadLetters } from '../schema/dead-letters.js';

// Written by the worker on terminal publish failure (PRD 3.3 item 5). Holds
// server-side diagnostic detail; the user-facing message lives on the post
// target's lastError (SECURITY.md 2.16).

export const createDeadLetterInput = z.object({
  postTargetId: z.uuid(),
  providerId: z.string().min(1).max(64),
  errorClass: z.string().min(1).max(128),
  errorDetail: z.record(z.string(), z.unknown()).default({}),
  attemptCount: z.number().int().min(0),
  correlationId: z.string().max(128).nullable().optional(),
});

export type CreateDeadLetterInput = z.infer<typeof createDeadLetterInput>;

export async function writeDeadLetter(
  db: Executor,
  workspaceId: string,
  input: CreateDeadLetterInput,
): Promise<{ id: string }> {
  const parsed = createDeadLetterInput.parse(input);
  const [row] = await db
    .insert(deadLetters)
    .values({
      workspaceId,
      postTargetId: parsed.postTargetId,
      providerId: parsed.providerId,
      errorClass: parsed.errorClass,
      errorDetail: parsed.errorDetail,
      attemptCount: parsed.attemptCount,
      correlationId: parsed.correlationId ?? null,
    })
    .returning({ id: deadLetters.id });
  if (!row) {
    throw new Error('dead-letter insert returned no row');
  }
  return row;
}

export async function findDeadLettersForTarget(
  db: Executor,
  workspaceId: string,
  postTargetId: string,
): Promise<Array<{ id: string; errorClass: string; attemptCount: number }>> {
  return db
    .select({
      id: deadLetters.id,
      errorClass: deadLetters.errorClass,
      attemptCount: deadLetters.attemptCount,
    })
    .from(deadLetters)
    .where(
      and(eq(deadLetters.workspaceId, workspaceId), eq(deadLetters.postTargetId, postTargetId)),
    );
}
