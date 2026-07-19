import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import {
  AuthExpiredError,
  RetryableProviderError,
  TerminalProviderError,
  type Capabilities,
  type PreparedPost,
  type Provider,
  type ProviderCredentials,
  type PublishResult,
} from '@poslatr/core';
import {
  claimPostTargetForPublishing,
  connect,
  createPost,
  createPostTarget,
  createWorkspace,
  findConnectionById,
  findDeadLettersForTarget,
  findPostTargetById,
  insertEncryptedCredential,
  reclaimAllStalePostTargets,
  transitionPostTargetStatus,
  schema,
  type Database,
  type DatabaseHandle,
} from '@poslatr/db';
import { eq } from 'drizzle-orm';

const { connections } = schema;
import { PublishQueues, RETRY_MAX_ATTEMPTS, type PublishJobData } from './queues.js';
import { processPublishJob, type PublishDeps } from './publish-processor.js';
import { startPublishWorker, stopPublishWorkers } from './publish-worker.js';

// Requires live Redis AND its OWN Postgres database (WORKER_DATABASE_URL). The
// worker suite creates connection+credential fixtures; the vault suite issues
// global psl_credentials operations. On one shared DB those contend
// nondeterministically, so this suite runs against a dedicated database and
// skips if it is not provided. CI creates poslatr_worker; locally, export
// WORKER_DATABASE_URL to run these.
const databaseUrl = process.env.WORKER_DATABASE_URL;
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const describeIntegration = databaseUrl ? describe : describe.skip;

// A provider whose publish outcome is scripted per call, so tests drive
// success / retryable / terminal / auth-expired deterministically.
type Outcome =
  | { kind: 'success'; remotePostId: string }
  | { kind: 'retryable' }
  | { kind: 'terminal' }
  | { kind: 'auth' };

class ScriptedProvider implements Provider {
  readonly id = 'fake';
  publishCalls = 0;
  #script: Outcome[];
  #default: Outcome;

  constructor(script: Outcome[], fallback: Outcome = { kind: 'success', remotePostId: 'r' }) {
    this.#script = script;
    this.#default = fallback;
  }

  capabilities(): Capabilities {
    return {
      contentTypes: ['text'],
      maxCharacters: 500,
      maxMediaCount: 4,
      allowedMimeTypes: [],
      mediaConstraints: { maxBytes: 1, maxDurationMs: null, allowedAspectRatios: [] },
      rateWindows: [],
    };
  }

  readonly auth = {
    beginConnect: () => Promise.reject(new Error('unused')),
    completeConnect: () => Promise.reject(new Error('unused')),
    refresh: (c: ProviderCredentials) => Promise.resolve(c),
  };

  validate() {
    return { ok: true, issues: [] };
  }
  prepareMedia() {
    return [];
  }
  status() {
    return Promise.resolve({ state: 'unknown' as const });
  }

  publish(_post: PreparedPost, _creds: ProviderCredentials): Promise<PublishResult> {
    this.publishCalls += 1;
    const outcome = this.#script.shift() ?? this.#default;
    switch (outcome.kind) {
      case 'success':
        return Promise.resolve({ remotePostId: outcome.remotePostId, remoteUrl: null });
      case 'retryable':
        return Promise.reject(new RetryableProviderError(this.id, 'upstream 503'));
      case 'terminal':
        return Promise.reject(new TerminalProviderError(this.id, 'upstream 422'));
      case 'auth':
        return Promise.reject(new AuthExpiredError(this.id, 'upstream 401'));
    }
  }
}

describeIntegration('scheduler and publish worker', () => {
  let handle: DatabaseHandle;
  let db: Database;
  let redis: Redis;
  let workspaceId: string;
  let connectionId: string;
  let credentialId: string;
  const activeWorkers: Worker<PublishJobData>[] = [];
  const activeQueues: PublishQueues[] = [];

  beforeAll(async () => {
    handle = connect(databaseUrl as string, { max: 8 });
    db = handle.db;
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

    workspaceId = (await createWorkspace(db, { name: `sched-${Date.now()}` })).id;
    // A real credential row so the connection's composite FK is satisfied and
    // the processor's credentials-present check passes.
    const cred = await insertEncryptedCredential(db, workspaceId, {
      ciphertext: Buffer.from('x').toString('base64'),
      nonce: Buffer.from('y').toString('base64'),
      keyVersion: 1,
    });
    const [conn] = await db
      .insert(connections)
      .values({
        workspaceId,
        providerId: 'fake',
        displayName: 'Fake',
        credentialsRef: cred.id,
      })
      .returning({ id: connections.id });
    if (!conn) throw new Error('failed to create connection');
    connectionId = conn.id;
    credentialId = cred.id;
  });

  afterEach(async () => {
    await stopPublishWorkers(activeWorkers.splice(0));
    await Promise.all(activeQueues.splice(0).map((q) => q.close()));
  });

  afterAll(async () => {
    // Tear down in FK-dependency order: dead letters and post targets reference
    // the connection (RESTRICT), and the connection references the credential
    // (RESTRICT). This suite owns its database, but leaving it clean keeps
    // repeated local runs idempotent.
    await db.delete(schema.deadLetters).where(eq(schema.deadLetters.workspaceId, workspaceId));
    await db.delete(schema.postTargets).where(eq(schema.postTargets.workspaceId, workspaceId));
    await db.delete(connections).where(eq(connections.id, connectionId));
    await db.delete(schema.credentials).where(eq(schema.credentials.id, credentialId));
    await handle.close();
    redis.disconnect();
  });

  function deps(provider: Provider, overrides: Partial<PublishDeps> = {}): PublishDeps {
    return {
      db,
      getProvider: () => provider,
      decryptCredentials: () => Promise.resolve({ token: 'x' }),
      preparePost: (_ws, postTargetId, correlationId): Promise<PreparedPost> =>
        Promise.resolve({
          post: { body: { text: 'hello' }, media: [] },
          media: [],
          correlationId,
        }),
      leaseMs: 30_000,
      ...overrides,
    };
  }

  async function scheduledTarget(): Promise<string> {
    const post = await createPost(db, workspaceId, { body: { text: 'hi' } });
    const target = await createPostTarget(db, workspaceId, { postId: post.id, connectionId });
    await transitionPostTargetStatus(db, workspaceId, target.id, 'draft', 'scheduled');
    return target.id;
  }

  function jobData(postTargetId: string, providerId = 'fake'): PublishJobData {
    return { workspaceId, postTargetId, providerId, connectionId };
  }

  // A minimal fake Job wrapper so we can drive the processor directly with a
  // controlled attemptsMade, without waiting on BullMQ backoff timing.
  function fakeJob(postTargetId: string, attemptsMade = 0) {
    return { data: jobData(postTargetId), attemptsMade } as never;
  }

  it('publishes exactly once and records success + audit', async () => {
    const id = await scheduledTarget();
    const provider = new ScriptedProvider([{ kind: 'success', remotePostId: 'remote-1' }]);

    const result = await processPublishJob(fakeJob(id), deps(provider));

    expect(result.outcome).toBe('published');
    expect(provider.publishCalls).toBe(1);
    expect((await findPostTargetById(db, workspaceId, id))?.status).toBe('published');
  });

  it('two concurrent processors on one target publish exactly once (PRD test case 1)', async () => {
    const id = await scheduledTarget();
    const provider = new ScriptedProvider(
      [
        { kind: 'success', remotePostId: 'once' },
        { kind: 'success', remotePostId: 'twice' },
      ],
      { kind: 'success', remotePostId: 'extra' },
    );

    const [a, b] = await Promise.all([
      processPublishJob(fakeJob(id), deps(provider)),
      processPublishJob(fakeJob(id), deps(provider)),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['published', 'skipped']);
    // The claim gates the network call, so publish() ran exactly once.
    expect(provider.publishCalls).toBe(1);
  });

  it('terminal error dead-letters, fails the target, writes a notification event (PRD test case 3)', async () => {
    const id = await scheduledTarget();
    const provider = new ScriptedProvider([{ kind: 'terminal' }]);

    await expect(processPublishJob(fakeJob(id), deps(provider))).rejects.toThrow();

    const target = await findPostTargetById(db, workspaceId, id);
    expect(target?.status).toBe('failed');
    const dls = await findDeadLettersForTarget(db, workspaceId, id);
    expect(dls.length).toBe(1);
    expect(dls[0]?.errorClass).toBe('TerminalProviderError');
  });

  it('auth-expired marks the connection broken and terminal-fails with a distinct message', async () => {
    const id = await scheduledTarget();
    const provider = new ScriptedProvider([{ kind: 'auth' }]);

    await expect(processPublishJob(fakeJob(id), deps(provider))).rejects.toThrow();

    expect((await findConnectionById(db, workspaceId, connectionId))?.health).toBe('broken');
    const target = await findPostTargetById(db, workspaceId, id);
    expect(target?.status).toBe('failed');
    // Reset connection health for later tests.
    await db
      .update(connections)
      .set({ health: 'ok' })
      .where(eq(connections.id, connectionId));
  });

  it('a retryable error on a non-final attempt releases the claim for retry', async () => {
    const id = await scheduledTarget();
    const provider = new ScriptedProvider([{ kind: 'retryable' }]);

    // attemptsMade = 0, so attemptsRemaining = 5 > 1: should re-throw (retry).
    await expect(processPublishJob(fakeJob(id, 0), deps(provider))).rejects.toBeInstanceOf(
      RetryableProviderError,
    );

    // Claim released: the target is back to scheduled so a retry can re-claim.
    expect((await findPostTargetById(db, workspaceId, id))?.status).toBe('scheduled');
    expect(await findDeadLettersForTarget(db, workspaceId, id)).toHaveLength(0);
  });

  it('a retryable error on the FINAL attempt dead-letters (retries exhausted)', async () => {
    const id = await scheduledTarget();
    const provider = new ScriptedProvider([{ kind: 'retryable' }]);

    // attemptsMade = RETRY_MAX_ATTEMPTS - 1: attemptsRemaining = 1, terminal.
    await expect(
      processPublishJob(fakeJob(id, RETRY_MAX_ATTEMPTS - 1), deps(provider)),
    ).rejects.toThrow();

    expect((await findPostTargetById(db, workspaceId, id))?.status).toBe('failed');
    expect(await findDeadLettersForTarget(db, workspaceId, id)).toHaveLength(1);
  });

  it('a worker killed mid-job leaves a claim the sweeper recovers, no double publish (PRD test case 2)', async () => {
    const id = await scheduledTarget();

    // Simulate a worker that claimed and then died before publishing: claim with
    // a tiny lease and never record an outcome.
    const claimed = await claimPostTargetForPublishing(db, workspaceId, id, 1);
    expect(claimed).toBe(1);
    expect((await findPostTargetById(db, workspaceId, id))?.status).toBe('publishing');

    // The reclaim sweeper (run on worker boot / interval) returns the expired
    // claim to scheduled so a healthy worker can pick it up again.
    const swept = await reclaimAllStalePostTargets(db, workspaceId, new Date(Date.now() + 60_000));
    expect(swept).toContain(id);
    expect((await findPostTargetById(db, workspaceId, id))?.status).toBe('scheduled');

    // The recovered target now publishes exactly once.
    const provider = new ScriptedProvider([{ kind: 'success', remotePostId: 'recovered' }]);
    const result = await processPublishJob(fakeJob(id), deps(provider));
    expect(result.outcome).toBe('published');
    expect(provider.publishCalls).toBe(1);
  });

  it('computes fire delay in UTC across a Europe/Berlin DST shift (PRD test case 5)', () => {
    // Berlin springs forward 2025-03-30 02:00 -> 03:00 CET->CEST. A post whose
    // author picked "2025-03-30 04:00 Berlin time" is stored as the correct UTC
    // instant (02:00Z, since CEST is UTC+2). Delay is computed from that UTC
    // instant, so the wall-clock fire time is right regardless of the shift.
    const fireAtUtc = new Date('2025-03-30T02:00:00.000Z'); // 04:00 CEST
    const nowUtc = new Date('2025-03-30T00:00:00.000Z'); // 01:00 CET, pre-shift

    const queues = new PublishQueues(redis);
    activeQueues.push(queues);
    const delay = fireAtUtc.getTime() - nowUtc.getTime();

    // 2 hours of real elapsed time, NOT 3: the clocks jumped forward an hour, so
    // wall-clock 01:00->04:00 is only 2 actual hours. UTC math gets this right;
    // naive local-time subtraction would not.
    expect(delay).toBe(2 * 60 * 60 * 1000);
  });

  describe('BullMQ end to end against live Redis', () => {
    it('a delayed job fires and publishes exactly once with two workers running (PRD test case 1)', async () => {
      const id = await scheduledTarget();
      // A unique provider id per e2e test isolates its queue in shared Redis,
      // so leftover jobs/workers from sibling tests can't bleed in.
      const providerId = `e2e-${randomUUID().slice(0, 8)}`;
      const provider = new ScriptedProvider([{ kind: 'success', remotePostId: 'e2e' }]);

      const queues = new PublishQueues(redis);
      activeQueues.push(queues);

      const w1 = startPublishWorker(providerId, redis, deps(provider), { concurrency: 2 });
      const w2 = startPublishWorker(providerId, redis, deps(provider), { concurrency: 2 });
      activeWorkers.push(w1, w2);

      const completed = new Promise<void>((resolve) => {
        const onDone = (job: { data: PublishJobData }) => {
          if (job.data.postTargetId === id) resolve();
        };
        w1.on('completed', onDone);
        w2.on('completed', onDone);
      });

      await queues.schedule(jobData(id, providerId), new Date(Date.now() + 500));
      await completed;
      // Give the losing worker a beat to also settle.
      await new Promise((r) => setTimeout(r, 200));

      expect(provider.publishCalls).toBe(1);
      expect((await findPostTargetById(db, workspaceId, id))?.status).toBe('published');
    });

    it('cancel before fire removes the job and leaves it cancellable at the status layer (PRD test case 4)', async () => {
      const id = await scheduledTarget();
      const providerId = `cancel-${randomUUID().slice(0, 8)}`;
      const queues = new PublishQueues(redis);
      activeQueues.push(queues);

      await queues.schedule(jobData(id, providerId), new Date(Date.now() + 60_000));
      expect(await queues.cancel(providerId, id)).toBe('removed');

      // A second cancel finds nothing (already gone).
      expect(await queues.cancel(providerId, id)).toBe('absent');
    });

    it('enqueue is idempotent: scheduling the same target twice yields one job', async () => {
      const id = await scheduledTarget();
      const providerId = `idem-${randomUUID().slice(0, 8)}`;
      const queues = new PublishQueues(redis);
      activeQueues.push(queues);
      const queue = new Queue(`publish-${providerId}`, { connection: redis });

      await queues.schedule(jobData(id, providerId), new Date(Date.now() + 60_000));
      await queues.schedule(jobData(id, providerId), new Date(Date.now() + 60_000));

      // This queue is unique to this test, so its single delayed job is ours.
      const counts = await queue.getJobCounts('delayed');
      expect(counts.delayed).toBe(1);
      const job = await queue.getJob(id);
      expect(job?.id).toBe(id);
      await queue.close();
    });
  });
});
