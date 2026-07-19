import { and, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../client.js';
import { NotFoundError, TransitionRaceLostError } from '../errors.js';
import { connections } from '../schema/connections.js';
import { postTargets } from '../schema/post-targets.js';
import { posts } from '../schema/posts.js';
import { assertLegalPostTargetTransition, type PostTargetStatus } from './transitions.js';

export const createPostTargetInput = z.object({
  postId: z.uuid(),
  connectionId: z.uuid(),
  bodyOverride: z.unknown().nullable().optional(),
  scheduledAt: z.date().nullable().optional(),
});

export type CreatePostTargetInput = z.infer<typeof createPostTargetInput>;

export async function createPostTarget(
  db: Executor,
  workspaceId: string,
  input: CreatePostTargetInput,
): Promise<{ id: string; status: PostTargetStatus }> {
  const parsed = createPostTargetInput.parse(input);

  // ISS-003-F1: resolve both parents inside this workspace before inserting.
  // The composite FKs in the schema make a cross-workspace row impossible
  // anyway, but resolving here turns a raw constraint violation into a typed
  // NotFoundError and keeps the check visible at the call site.
  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, parsed.postId), eq(posts.workspaceId, workspaceId)))
    .limit(1);
  if (!post) {
    throw new NotFoundError('post', parsed.postId);
  }

  const [connection] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.id, parsed.connectionId), eq(connections.workspaceId, workspaceId)))
    .limit(1);
  if (!connection) {
    throw new NotFoundError('connection', parsed.connectionId);
  }

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
  db: Executor,
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
  db: Executor,
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
  db: Executor,
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

export const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Claims a target for publishing and stamps a lease (ISS-003-F3).
 *
 * Identical race semantics to transitionPostTargetStatus: the conditional
 * WHERE means exactly one concurrent worker wins. The lease is what makes the
 * claim recoverable, so a worker that dies mid-publish does not strand the row.
 *
 * Returns 1 on a successful claim, 0 when another worker won.
 */
export async function claimPostTargetForPublishing(
  db: Executor,
  workspaceId: string,
  id: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): Promise<number> {
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new RangeError(`leaseMs must be a positive integer, got ${leaseMs}`);
  }

  const now = new Date();
  const updated = await db
    .update(postTargets)
    .set({
      status: 'publishing',
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(postTargets.id, id),
        eq(postTargets.workspaceId, workspaceId),
        eq(postTargets.status, 'scheduled'),
      ),
    )
    .returning({ id: postTargets.id });

  return updated.length;
}

/**
 * Returns a target whose publishing claim has expired to `scheduled` so it can
 * be picked up again (ISS-003-F3).
 *
 * The expired-lease predicate is the whole safety story: a target being
 * actively published has a future claim_expires_at and cannot be reclaimed, so
 * this can never yank work away from a live worker or cause a double publish.
 */
export async function reclaimStalePostTarget(
  db: Executor,
  workspaceId: string,
  id: string,
  now: Date = new Date(),
): Promise<number> {
  const updated = await db
    .update(postTargets)
    .set({ status: 'scheduled', claimedAt: null, claimExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(postTargets.id, id),
        eq(postTargets.workspaceId, workspaceId),
        eq(postTargets.status, 'publishing'),
        lt(postTargets.claimExpiresAt, now),
      ),
    )
    .returning({ id: postTargets.id });

  return updated.length;
}

/**
 * Sweeper form of reclaimStalePostTarget: returns every stale target across the
 * workspace. ISS-007 runs this on worker boot and on an interval.
 */
export async function reclaimAllStalePostTargets(
  db: Executor,
  workspaceId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const updated = await db
    .update(postTargets)
    .set({ status: 'scheduled', claimedAt: null, claimExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(postTargets.workspaceId, workspaceId),
        eq(postTargets.status, 'publishing'),
        lt(postTargets.claimExpiresAt, now),
      ),
    )
    .returning({ id: postTargets.id });

  return updated.map((row) => row.id);
}

// Attempt count is incremented server-side via SQL, never set from a caller-
// supplied total (SECURITY.md 2.3: derived values computed server-side).
export async function incrementAttemptCount(
  db: Executor,
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

/**
 * Records a completed publish and moves the target to its terminal `published`
 * state in a single statement, so success can never be half-recorded.
 *
 * ISS-003-F4: this previously wrote the remote ids without setting status,
 * leaving successfully published targets stuck in `publishing` forever.
 * ISS-003-F5: it also returned void and ignored the affected row count, so a
 * cross-workspace or already-terminal call silently did nothing.
 *
 * The `status = 'publishing'` guard makes double-recording impossible: only the
 * worker still holding the claim can close it out.
 *
 * Returns the number of rows updated: 1 on success, 0 if the claim was lost or
 * the target already reached a terminal state.
 */
export async function recordPublishSuccess(
  db: Executor,
  workspaceId: string,
  id: string,
  remote: { remotePostId: string; remoteUrl?: string | null },
): Promise<number> {
  const updated = await db
    .update(postTargets)
    .set({
      status: 'published',
      remotePostId: remote.remotePostId,
      remoteUrl: remote.remoteUrl ?? null,
      publishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(postTargets.id, id),
        eq(postTargets.workspaceId, workspaceId),
        eq(postTargets.status, 'publishing'),
      ),
    )
    .returning({ id: postTargets.id });

  return updated.length;
}

export async function recordPublishSuccessOrThrow(
  db: Executor,
  workspaceId: string,
  id: string,
  remote: { remotePostId: string; remoteUrl?: string | null },
): Promise<void> {
  const count = await recordPublishSuccess(db, workspaceId, id, remote);
  if (count === 0) {
    throw new TransitionRaceLostError('post target', id, 'publishing');
  }
}
