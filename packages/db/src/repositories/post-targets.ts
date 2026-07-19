import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { TransitionRaceLostError } from '../errors.js';
import { postTargets } from '../schema/post-targets.js';
import { assertLegalPostTargetTransition, type PostTargetStatus } from './transitions.js';

export const createPostTargetInput = z.object({
  postId: z.uuid(),
  connectionId: z.uuid(),
  bodyOverride: z.unknown().nullable().optional(),
  scheduledAt: z.date().nullable().optional(),
});

export type CreatePostTargetInput = z.infer<typeof createPostTargetInput>;

export async function createPostTarget(
  db: Database,
  workspaceId: string,
  input: CreatePostTargetInput,
): Promise<{ id: string; status: PostTargetStatus }> {
  const parsed = createPostTargetInput.parse(input);
  const [row] = await db
    .insert(postTargets)
    .values({
      workspaceId,
      postId: parsed.postId,
      connectionId: parsed.connectionId,
      bodyOverride: parsed.bodyOverride ?? null,
      scheduledAt: parsed.scheduledAt ?? null,
    })
    .returning({ id: postTargets.id, status: postTargets.status });

  if (!row) {
    throw new Error('Insert returned no row');
  }
  return row;
}

export async function findPostTargetById(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<{ id: string; status: PostTargetStatus; attemptCount: number } | null> {
  const [row] = await db
    .select({
      id: postTargets.id,
      status: postTargets.status,
      attemptCount: postTargets.attemptCount,
    })
    .from(postTargets)
    .where(and(eq(postTargets.id, id), eq(postTargets.workspaceId, workspaceId)))
    .limit(1);

  return row ?? null;
}

/**
 * The claim operation ISS-007's worker depends on. Exactly one concurrent
 * caller can move a target scheduled -> publishing; every other caller gets 0
 * and must exit cleanly (PRD 3.3 item 2).
 */
export async function transitionPostTargetStatus(
  db: Database,
  workspaceId: string,
  id: string,
  from: PostTargetStatus,
  to: PostTargetStatus,
): Promise<number> {
  assertLegalPostTargetTransition(from, to);

  const updated = await db
    .update(postTargets)
    .set({ status: to, updatedAt: new Date() })
    .where(
      and(
        eq(postTargets.id, id),
        eq(postTargets.workspaceId, workspaceId),
        eq(postTargets.status, from),
      ),
    )
    .returning({ id: postTargets.id });

  return updated.length;
}

export async function transitionPostTargetStatusOrThrow(
  db: Database,
  workspaceId: string,
  id: string,
  from: PostTargetStatus,
  to: PostTargetStatus,
): Promise<void> {
  const count = await transitionPostTargetStatus(db, workspaceId, id, from, to);
  if (count === 0) {
    throw new TransitionRaceLostError('post target', id, from);
  }
}

// Attempt count is incremented server-side via SQL, never set from a caller-
// supplied total (SECURITY.md 2.3: derived values computed server-side).
export async function incrementAttemptCount(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<number> {
  const [row] = await db
    .update(postTargets)
    .set({
      attemptCount: sql`${postTargets.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(postTargets.id, id), eq(postTargets.workspaceId, workspaceId)))
    .returning({ attemptCount: postTargets.attemptCount });

  if (!row) {
    throw new TransitionRaceLostError('post target', id, 'any');
  }
  return row.attemptCount;
}

export async function recordPublishSuccess(
  db: Database,
  workspaceId: string,
  id: string,
  remote: { remotePostId: string; remoteUrl?: string | null },
): Promise<void> {
  await db
    .update(postTargets)
    .set({
      remotePostId: remote.remotePostId,
      remoteUrl: remote.remoteUrl ?? null,
      publishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(postTargets.id, id), eq(postTargets.workspaceId, workspaceId)));
}
