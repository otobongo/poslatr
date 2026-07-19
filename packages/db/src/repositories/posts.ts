import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { TransitionRaceLostError } from '../errors.js';
import { posts } from '../schema/posts.js';
import { assertLegalPostTransition, type PostStatus } from './transitions.js';

// Whitelist of client-writable fields. Status, workspaceId, and timestamps are
// server-controlled and deliberately absent (SECURITY.md 2.7, mass assignment).
export const createPostInput = z.object({
  body: z.unknown(),
  scheduledAt: z.date().nullable().optional(),
  timezone: z.string().min(1).max(64).nullable().optional(),
});

export type CreatePostInput = z.infer<typeof createPostInput>;

export async function createPost(
  db: Database,
  workspaceId: string,
  input: CreatePostInput,
): Promise<{ id: string; status: PostStatus }> {
  const parsed = createPostInput.parse(input);
  const [row] = await db
    .insert(posts)
    .values({
      workspaceId,
      body: parsed.body,
      scheduledAt: parsed.scheduledAt ?? null,
      timezone: parsed.timezone ?? null,
    })
    .returning({ id: posts.id, status: posts.status });

  if (!row) {
    throw new Error('Insert returned no row');
  }
  return row;
}

export async function findPostById(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<{ id: string; status: PostStatus } | null> {
  const [row] = await db
    .select({ id: posts.id, status: posts.status })
    .from(posts)
    // Every lookup is scoped by workspace: no IDOR (SECURITY.md 2.6).
    .where(and(eq(posts.id, id), eq(posts.workspaceId, workspaceId)))
    .limit(1);

  return row ?? null;
}

/**
 * Conditional status transition. The WHERE clause pins the expected current
 * status, so a losing concurrent caller updates zero rows rather than
 * clobbering state (PRD 3.3 item 2).
 *
 * Returns the number of rows updated: 1 on success, 0 when the race was lost.
 * Illegal transitions throw before touching the database.
 */
export async function transitionPostStatus(
  db: Database,
  workspaceId: string,
  id: string,
  from: PostStatus,
  to: PostStatus,
): Promise<number> {
  assertLegalPostTransition(from, to);

  const updated = await db
    .update(posts)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(posts.id, id), eq(posts.workspaceId, workspaceId), eq(posts.status, from)))
    .returning({ id: posts.id });

  return updated.length;
}

/**
 * Same as transitionPostStatus but throws TransitionRaceLostError when the
 * conditional update matches nothing, for callers that treat losing the race as
 * exceptional rather than expected.
 */
export async function transitionPostStatusOrThrow(
  db: Database,
  workspaceId: string,
  id: string,
  from: PostStatus,
  to: PostStatus,
): Promise<void> {
  const count = await transitionPostStatus(db, workspaceId, id, from, to);
  if (count === 0) {
    throw new TransitionRaceLostError('post', id, from);
  }
}
