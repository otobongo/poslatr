import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, withTransaction, type Database, type DatabaseHandle } from '../client.js';
import {
  IllegalStatusTransitionError,
  NotFoundError,
  TransitionRaceLostError,
} from '../errors.js';
import { createPost, findPostById, transitionPostStatus } from './posts.js';
import {
  claimPostTargetForPublishing,
  createPostTarget,
  findPostTargetById,
  incrementAttemptCount,
  reclaimAllStalePostTargets,
  reclaimStalePostTarget,
  recordPublishSuccess,
  recordPublishSuccessOrThrow,
  transitionPostTargetStatus,
  transitionPostTargetStatusOrThrow,
} from './post-targets.js';
import { createUser, createWorkspace } from './workspaces.js';
import { connections } from '../schema/connections.js';
import { postTargets } from '../schema/post-targets.js';
import { auditEvents } from '../schema/audit-events.js';
import { and, eq } from 'drizzle-orm';

// These tests require a live Postgres. Set DATABASE_URL to run them; without
// it the suite skips rather than silently passing on nothing.
const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

/**
 * Drizzle wraps driver errors in DrizzleQueryError and puts the Postgres
 * message on `.cause`. Asserting only on the outer message would pass for any
 * failed query, so these helpers walk the cause chain and match the real
 * database error text.
 */
async function expectDatabaseError(
  operation: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let thrown: unknown;
  try {
    await operation();
  } catch (err) {
    thrown = err;
  }

  expect(thrown, 'expected the database to reject this operation').toBeDefined();

  const messages: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }

  expect(
    messages.some((message) => pattern.test(message)),
    `expected a database error matching ${String(pattern)}, got: ${messages.join(' | ')}`,
  ).toBe(true);
}

describeIntegration('repositories against a live database', () => {
  let handle: DatabaseHandle;
  let db: Database;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let connectionId: string;
  let otherConnectionId: string;

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

    const [otherConn] = await db
      .insert(connections)
      .values({
        workspaceId: otherWorkspaceId,
        providerId: 'fake',
        displayName: 'Other workspace connection',
      })
      .returning({ id: connections.id });
    if (!otherConn) throw new Error('failed to create other test connection');
    otherConnectionId = otherConn.id;
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

  // ISS-003-F1. These are the tests whose absence let the cross-workspace
  // confused deputy ship: the original suite only covered single-table IDOR.
  describe('cross-workspace integrity (ISS-003-F1)', () => {
    it('refuses a target pointing at another workspace post', async () => {
      const victimPost = await createPost(db, workspaceId, { body: { secret: 'victim' } });

      await expect(
        createPostTarget(db, otherWorkspaceId, {
          postId: victimPost.id,
          connectionId: otherConnectionId,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('refuses a target bound to another workspace connection', async () => {
      const post = await createPost(db, workspaceId, { body: { text: 'mine' } });

      await expect(
        createPostTarget(db, workspaceId, { postId: post.id, connectionId: otherConnectionId }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    // The repository guard above can be bypassed by any future code path that
    // inserts directly, so assert the database itself rejects the row too.
    it('is rejected by the composite foreign key even bypassing the repository', async () => {
      const victimPost = await createPost(db, workspaceId, { body: { secret: 'victim' } });

      await expectDatabaseError(
        () =>
          db.insert(postTargets).values({
            workspaceId: otherWorkspaceId,
            postId: victimPost.id,
            connectionId: otherConnectionId,
          }),
        /violates foreign key constraint "psl_post_targets_post_workspace_fk"/i,
      );
    });
  });

  // ISS-003-F4 and F5: recordPublishSuccess had no test at all, which is how it
  // shipped without ever setting status.
  describe('recordPublishSuccess (ISS-003-F4, F5)', () => {
    async function claimedTarget(): Promise<string> {
      const post = await createPost(db, workspaceId, { body: { text: 'publish' } });
      const target = await createPostTarget(db, workspaceId, { postId: post.id, connectionId });
      await transitionPostTargetStatus(db, workspaceId, target.id, 'draft', 'scheduled');
      await claimPostTargetForPublishing(db, workspaceId, target.id);
      return target.id;
    }

    it('moves the target to published, not just recording remote ids', async () => {
      const id = await claimedTarget();

      const rows = await recordPublishSuccess(db, workspaceId, id, { remotePostId: 'remote-1' });
      expect(rows).toBe(1);

      const after = await findPostTargetById(db, workspaceId, id);
      expect(after?.status).toBe('published');
    });

    it('reports zero rows instead of silently no-opping cross-workspace', async () => {
      const id = await claimedTarget();

      const rows = await recordPublishSuccess(db, otherWorkspaceId, id, {
        remotePostId: 'attacker',
      });
      expect(rows).toBe(0);
      expect((await findPostTargetById(db, workspaceId, id))?.status).toBe('publishing');
    });

    it('cannot double-record: the second call finds no publishing row', async () => {
      const id = await claimedTarget();

      expect(await recordPublishSuccess(db, workspaceId, id, { remotePostId: 'first' })).toBe(1);
      expect(await recordPublishSuccess(db, workspaceId, id, { remotePostId: 'second' })).toBe(0);

      const [row] = await db
        .select({ remotePostId: postTargets.remotePostId })
        .from(postTargets)
        .where(eq(postTargets.id, id));
      expect(row?.remotePostId).toBe('first');
    });

    it('throws in the OrThrow variant when the claim was lost', async () => {
      const id = await claimedTarget();
      await recordPublishSuccessOrThrow(db, workspaceId, id, { remotePostId: 'first' });

      await expect(
        recordPublishSuccessOrThrow(db, workspaceId, id, { remotePostId: 'second' }),
      ).rejects.toBeInstanceOf(TransitionRaceLostError);
    });
  });

  // ISS-003-F3: a worker killed mid-publish previously stranded the row forever.
  describe('stale claim recovery (ISS-003-F3)', () => {
    async function scheduledTarget(): Promise<string> {
      const post = await createPost(db, workspaceId, { body: { text: 'lease' } });
      const target = await createPostTarget(db, workspaceId, { postId: post.id, connectionId });
      await transitionPostTargetStatus(db, workspaceId, target.id, 'draft', 'scheduled');
      return target.id;
    }

    it('stamps a lease when claiming', async () => {
      const id = await scheduledTarget();
      expect(await claimPostTargetForPublishing(db, workspaceId, id, 60_000)).toBe(1);

      const [row] = await db
        .select({ claimedAt: postTargets.claimedAt, expires: postTargets.claimExpiresAt })
        .from(postTargets)
        .where(eq(postTargets.id, id));
      expect(row?.claimedAt).toBeInstanceOf(Date);
      expect(row?.expires).toBeInstanceOf(Date);
    });

    it('still allows exactly one winner under concurrency', async () => {
      const id = await scheduledTarget();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => claimPostTargetForPublishing(db, workspaceId, id)),
      );
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    });

    it('refuses to reclaim a target whose lease is still live', async () => {
      const id = await scheduledTarget();
      await claimPostTargetForPublishing(db, workspaceId, id, 60_000);

      expect(await reclaimStalePostTarget(db, workspaceId, id)).toBe(0);
      expect((await findPostTargetById(db, workspaceId, id))?.status).toBe('publishing');
    });

    it('reclaims a target whose lease expired, making it claimable again', async () => {
      const id = await scheduledTarget();
      await claimPostTargetForPublishing(db, workspaceId, id, 1);

      // Evaluate the sweep at a point past the lease rather than sleeping.
      const future = new Date(Date.now() + 60_000);
      expect(await reclaimStalePostTarget(db, workspaceId, id, future)).toBe(1);

      const after = await findPostTargetById(db, workspaceId, id);
      expect(after?.status).toBe('scheduled');
      // The whole point: it can be picked up again rather than stranded.
      expect(await claimPostTargetForPublishing(db, workspaceId, id)).toBe(1);
    });

    it('clears the lease columns on reclaim', async () => {
      const id = await scheduledTarget();
      await claimPostTargetForPublishing(db, workspaceId, id, 1);
      await reclaimStalePostTarget(db, workspaceId, id, new Date(Date.now() + 60_000));

      const [row] = await db
        .select({ claimedAt: postTargets.claimedAt, expires: postTargets.claimExpiresAt })
        .from(postTargets)
        .where(eq(postTargets.id, id));
      expect(row?.claimedAt).toBeNull();
      expect(row?.expires).toBeNull();
    });

    it('sweeps every stale target in the workspace at once', async () => {
      const ids = await Promise.all([scheduledTarget(), scheduledTarget()]);
      for (const id of ids) {
        await claimPostTargetForPublishing(db, workspaceId, id, 1);
      }

      const swept = await reclaimAllStalePostTargets(
        db,
        workspaceId,
        new Date(Date.now() + 60_000),
      );
      for (const id of ids) {
        expect(swept).toContain(id);
      }
    });

    it('does not reclaim across workspaces', async () => {
      const id = await scheduledTarget();
      await claimPostTargetForPublishing(db, workspaceId, id, 1);

      const future = new Date(Date.now() + 60_000);
      expect(await reclaimStalePostTarget(db, otherWorkspaceId, id, future)).toBe(0);
    });
  });

  // ISS-003-F6: SECURITY.md 2.3 bounds that were previously unenforced.
  describe('input bounds (ISS-003-F6)', () => {
    it('rejects a scheduled_at in the past', async () => {
      await expect(
        createPost(db, workspaceId, { body: { text: 'x' }, scheduledAt: new Date(Date.now() - 1) }),
      ).rejects.toThrow(/future/i);
    });

    it('accepts a scheduled_at in the future', async () => {
      const post = await createPost(db, workspaceId, {
        body: { text: 'x' },
        scheduledAt: new Date(Date.now() + 60_000),
      });
      expect(post.status).toBe('draft');
    });

    it('rejects a bogus timezone', async () => {
      await expect(
        createPost(db, workspaceId, { body: { text: 'x' }, timezone: 'Not/AZone' }),
      ).rejects.toThrow(/IANA/i);
    });

    it('accepts real IANA zones including UTC', async () => {
      for (const timezone of ['UTC', 'Europe/Berlin', 'America/New_York']) {
        const post = await createPost(db, workspaceId, { body: { text: 'tz' }, timezone });
        expect(post.id).toBeTruthy();
      }
    });

    it('rejects a body over the global size ceiling', async () => {
      const huge = { text: 'x'.repeat(300 * 1024) };
      await expect(createPost(db, workspaceId, { body: huge })).rejects.toThrow(/bytes/i);
    });
  });

  // ISS-003-F7: repositories had no way to compose atomic multi-statement work.
  describe('transactions (ISS-003-F7)', () => {
    it('commits both statements together on success', async () => {
      const result = await withTransaction(db, async (tx) => {
        const post = await createPost(tx, workspaceId, { body: { text: 'tx' } });
        const target = await createPostTarget(tx, workspaceId, { postId: post.id, connectionId });
        return { post, target };
      });

      expect(await findPostById(db, workspaceId, result.post.id)).not.toBeNull();
      expect(await findPostTargetById(db, workspaceId, result.target.id)).not.toBeNull();
    });

    it('rolls the post back when a later statement fails', async () => {
      let postId: string | undefined;

      await expect(
        withTransaction(db, async (tx) => {
          const post = await createPost(tx, workspaceId, { body: { text: 'rollback' } });
          postId = post.id;
          // Cross-workspace connection: fails, so the post must not persist.
          await createPostTarget(tx, workspaceId, {
            postId: post.id,
            connectionId: otherConnectionId,
          });
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(postId).toBeDefined();
      expect(await findPostById(db, workspaceId, postId as string)).toBeNull();
    });
  });

  // ISS-003-F8: satisfies PRD ISS-010 test case 1 ahead of that issue.
  describe('audit table is append-only (ISS-003-F8)', () => {
    async function seedAuditEvent(): Promise<string> {
      const [row] = await db
        .insert(auditEvents)
        .values({
          workspaceId,
          actor: 'test',
          action: 'publish',
          entityType: 'post',
          outcome: 'success',
        })
        .returning({ id: auditEvents.id });
      if (!row) throw new Error('failed to insert audit event');
      return row.id;
    }

    it('permits INSERT', async () => {
      expect(await seedAuditEvent()).toBeTruthy();
    });

    it('rejects UPDATE at the database level', async () => {
      const id = await seedAuditEvent();
      await expectDatabaseError(
        () => db.update(auditEvents).set({ outcome: 'tampered' }).where(eq(auditEvents.id, id)),
        /append-only: UPDATE is not permitted/i,
      );
    });

    it('rejects DELETE at the database level', async () => {
      const id = await seedAuditEvent();
      await expectDatabaseError(
        () => db.delete(auditEvents).where(and(eq(auditEvents.id, id), eq(auditEvents.actor, 'test'))),
        /append-only: DELETE is not permitted/i,
      );
    });
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
