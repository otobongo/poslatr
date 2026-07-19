import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Database, type DatabaseHandle } from '../client.js';
import { IllegalStatusTransitionError, TransitionRaceLostError } from '../errors.js';
import { createPost, findPostById, transitionPostStatus } from './posts.js';
import {
  createPostTarget,
  findPostTargetById,
  incrementAttemptCount,
  transitionPostTargetStatus,
  transitionPostTargetStatusOrThrow,
} from './post-targets.js';
import { createUser, createWorkspace } from './workspaces.js';
import { connections } from '../schema/connections.js';

// These tests require a live Postgres. Set DATABASE_URL to run them; without
// it the suite skips rather than silently passing on nothing.
const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('repositories against a live database', () => {
  let handle: DatabaseHandle;
  let db: Database;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let connectionId: string;

  beforeAll(async () => {
    handle = connect(databaseUrl as string, { max: 5 });
    db = handle.db;

    const ws = await createWorkspace(db, { name: `test-${Date.now()}` });
    workspaceId = ws.id;
    const other = await createWorkspace(db, { name: `other-${Date.now()}` });
    otherWorkspaceId = other.id;

    const [conn] = await db
      .insert(connections)
      .values({
        workspaceId,
        providerId: 'fake',
        displayName: 'Test connection',
      })
      .returning({ id: connections.id });
    if (!conn) throw new Error('failed to create test connection');
    connectionId = conn.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('creates a post in draft and reads it back', async () => {
    const post = await createPost(db, workspaceId, { body: { text: 'hello' } });
    expect(post.status).toBe('draft');

    const found = await findPostById(db, workspaceId, post.id);
    expect(found?.id).toBe(post.id);
  });

  it('does not leak a post across workspace boundaries', async () => {
    const post = await createPost(db, workspaceId, { body: { text: 'private' } });

    // Same id, different workspace: must not resolve (SECURITY.md 2.6, IDOR).
    const leaked = await findPostById(db, otherWorkspaceId, post.id);
    expect(leaked).toBeNull();
  });

  it('refuses a cross-workspace transition', async () => {
    const post = await createPost(db, workspaceId, { body: { text: 'x' } });
    const rows = await transitionPostStatus(db, otherWorkspaceId, post.id, 'draft', 'scheduled');
    expect(rows).toBe(0);

    const stillDraft = await findPostById(db, workspaceId, post.id);
    expect(stillDraft?.status).toBe('draft');
  });

  it('moves draft -> scheduled and reflects it in the row', async () => {
    const post = await createPost(db, workspaceId, { body: { text: 'x' } });
    const rows = await transitionPostStatus(db, workspaceId, post.id, 'draft', 'scheduled');
    expect(rows).toBe(1);
    expect((await findPostById(db, workspaceId, post.id))?.status).toBe('scheduled');
  });

  it('throws on an illegal transition without touching the row', async () => {
    const post = await createPost(db, workspaceId, { body: { text: 'x' } });
    await expect(
      transitionPostStatus(db, workspaceId, post.id, 'draft', 'published'),
    ).rejects.toBeInstanceOf(IllegalStatusTransitionError);

    expect((await findPostById(db, workspaceId, post.id))?.status).toBe('draft');
  });

  it('returns 0 when the row is not in the expected from-status', async () => {
    const post = await createPost(db, workspaceId, { body: { text: 'x' } });
    // Row is draft, but we claim it is scheduled.
    const rows = await transitionPostStatus(db, workspaceId, post.id, 'scheduled', 'publishing');
    expect(rows).toBe(0);
  });

  describe('post target claim race (PRD ISS-003 test case 1)', () => {
    it('lets exactly one of two concurrent claims win', async () => {
      const post = await createPost(db, workspaceId, { body: { text: 'race' } });
      const target = await createPostTarget(db, workspaceId, { postId: post.id, connectionId });
      await transitionPostTargetStatus(db, workspaceId, target.id, 'draft', 'scheduled');

      // Two workers racing to claim the same target.
      const [first, second] = await Promise.all([
        transitionPostTargetStatus(db, workspaceId, target.id, 'scheduled', 'publishing'),
        transitionPostTargetStatus(db, workspaceId, target.id, 'scheduled', 'publishing'),
      ]);

      expect(first + second).toBe(1);
      expect((await findPostTargetById(db, workspaceId, target.id))?.status).toBe('publishing');
    });

    it('surfaces the lost race as a typed error in the throwing variant', async () => {
      const post = await createPost(db, workspaceId, { body: { text: 'race2' } });
      const target = await createPostTarget(db, workspaceId, { postId: post.id, connectionId });
      await transitionPostTargetStatus(db, workspaceId, target.id, 'draft', 'scheduled');

      await transitionPostTargetStatusOrThrow(db, workspaceId, target.id, 'scheduled', 'publishing');

      await expect(
        transitionPostTargetStatusOrThrow(db, workspaceId, target.id, 'scheduled', 'publishing'),
      ).rejects.toBeInstanceOf(TransitionRaceLostError);
    });

    it('holds under higher concurrency: exactly one winner out of ten', async () => {
      const post = await createPost(db, workspaceId, { body: { text: 'race10' } });
      const target = await createPostTarget(db, workspaceId, { postId: post.id, connectionId });
      await transitionPostTargetStatus(db, workspaceId, target.id, 'draft', 'scheduled');

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          transitionPostTargetStatus(db, workspaceId, target.id, 'scheduled', 'publishing'),
        ),
      );

      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    });
  });

  it('increments attempt count server-side', async () => {
    const post = await createPost(db, workspaceId, { body: { text: 'attempts' } });
    const target = await createPostTarget(db, workspaceId, { postId: post.id, connectionId });

    expect(await incrementAttemptCount(db, workspaceId, target.id)).toBe(1);
    expect(await incrementAttemptCount(db, workspaceId, target.id)).toBe(2);
  });

  it('rejects a malformed input at the zod boundary', async () => {
    await expect(
      createPostTarget(db, workspaceId, {
        postId: 'not-a-uuid',
        connectionId,
      }),
    ).rejects.toThrow();
  });

  it('rejects a user with an invalid email at the zod boundary', async () => {
    await expect(
      createUser(db, workspaceId, { email: 'nope', displayName: 'X' }),
    ).rejects.toThrow();
  });
});
