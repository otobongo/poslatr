import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../client.js';
import { TransitionRaceLostError } from '../errors.js';
import { posts } from '../schema/posts.js';
import { assertLegalPostTransition, type PostStatus } from './transitions.js';

// Hard global ceiling on serialized post body size (SECURITY.md 2.3), applied
// independently of any provider's declared character limit.
export const MAX_POST_BODY_BYTES = 256 * 1024;

// Validates against the runtime's IANA database rather than a hardcoded list.
// Note Intl.supportedValuesOf('timeZone') omits "UTC", so constructing a
// formatter is the check that accepts every genuinely valid zone.
export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const postBody = z.unknown().refine(
  (value) => {
    if (value === undefined) return false;
    try {
      return new TextEncoder().encode(JSON.stringify(value) ?? '').length <= MAX_POST_BODY_BYTES;
    } catch {
      // Circular structures and similar are not storable as jsonb.
      return false;
    }
  },
  { message: `body must be JSON-serializable and at most ${MAX_POST_BODY_BYTES} bytes` },
);

// Whitelist of client-writable fields. Status, workspaceId, and timestamps are
// server-controlled and deliberately absent (SECURITY.md 2.7, mass assignment).
export const createPostInput = z.object({
  body: postBody,
  // SECURITY.md 2.3: scheduled_at must be in the future at schedule time.
  scheduledAt: z
    .date()
    .refine((d) => d.getTime() > Date.now(), { message: 'scheduledAt must be in the future' })
    .nullable()
    .optional(),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidIanaTimezone, { message: 'timezone must be a valid IANA identifier' })
    .nullable()
    .optional(),
});

export type CreatePostInput = z.infer<typeof createPostInput>;

export async function createPost(
  db: Executor,
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
  db: Executor,
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
  db: Executor,
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
  db: Executor,
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
